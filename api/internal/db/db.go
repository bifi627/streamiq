// Package db is the API's database: the migrations at start-up and a pool connected
// as streamiq_app, a role that owns no table, so row-level security hides every
// tenant-owned row unless the transaction names its tenant (InTenant).
package db

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"streamiq/api/migrations"
)

// AppRole is the role the API connects as (api/migrations/0002_rls.sql).
const AppRole = "streamiq_app"

type DB struct{ pool *pgxpool.Pool }

// Open migrates the database as its owner (ownerURL), gives AppRole appPassword and
// connects as AppRole to the same database.
func Open(ctx context.Context, ownerURL, appPassword string) (*DB, error) {
	if err := migrations.Up(ctx, ownerURL); err != nil {
		return nil, err
	}
	if err := setAppPassword(ctx, ownerURL, appPassword); err != nil {
		return nil, err
	}
	cfg, err := pgxpool.ParseConfig(ownerURL)
	if err != nil {
		return nil, err
	}
	cfg.ConnConfig.User, cfg.ConnConfig.Password = AppRole, appPassword
	return Connect(ctx, cfg)
}

// Connect opens a pool with cfg as it is: tests connect as another role or with one connection.
func Connect(ctx context.Context, cfg *pgxpool.Config) (*DB, error) {
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &DB{pool}, nil
}

// setAppPassword: ALTER ROLE takes no parameters, hence the quoted literal.
func setAppPassword(ctx context.Context, ownerURL, password string) error {
	conn, err := pgx.Connect(ctx, ownerURL)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close(ctx) }()
	_, err = conn.Exec(ctx, `ALTER ROLE `+AppRole+` LOGIN PASSWORD '`+strings.ReplaceAll(password, `'`, `''`)+`'`)
	return err
}

func (d *DB) Close() { d.pool.Close() }

// InTenant runs fn in a transaction that sees tenant's rows only: the one place the
// tenant is set. set_config's third argument makes it transaction-local, so it never
// outlives the transaction on its pooled connection.
func (d *DB) InTenant(ctx context.Context, tenant string, fn func(pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, d.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenant); err != nil {
			return err
		}
		return fn(tx)
	})
}

// NoTenant is the pool itself, for users (not tenant-owned) and the SECURITY DEFINER
// lookups that find the tenant. Every tenant-owned table reads as empty through it.
func (d *DB) NoTenant() *pgxpool.Pool { return d.pool }
