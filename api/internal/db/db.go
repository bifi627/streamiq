// Package db is the API's database: the migrations at start-up and a pool connected
// as streamiq_app, a role that owns no table, so row-level security hides every
// tenant-owned row unless the transaction names its tenant (InTenant).
package db

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"streamiq/api/migrations"
)

// AppRole is the role the API connects as (api/migrations/0002_rls.sql).
const AppRole = "streamiq_app"

type DB struct{ pool *pgxpool.Pool }

// Open migrates the database as its owner (ownerURL), gives AppRole appPassword and
// connects as AppRole to the same database.
func Open(ctx context.Context, ownerURL, appPassword string) (*DB, error) {
	if appPassword == "" {
		return nil, errors.New("STREAMIQ_APP_DB_PASSWORD is not set")
	}
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
// Every timestamptz scans as UTC, so the JSON the API sends ends in Z whatever the
// server's time zone (pgx's default is time.Local).
func Connect(ctx context.Context, cfg *pgxpool.Config) (*DB, error) {
	cfg.AfterConnect = func(_ context.Context, c *pgx.Conn) error {
		c.TypeMap().RegisterType(&pgtype.Type{
			Name:  "timestamptz",
			OID:   pgtype.TimestamptzOID,
			Codec: &pgtype.TimestamptzCodec{ScanLocation: time.UTC},
		})
		return nil
	}
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
// tenant is set (and InClaimedTenant). set_config's third argument makes it transaction-local, so it never
// outlives the transaction on its pooled connection.
func (d *DB) InTenant(ctx context.Context, tenant string, fn func(pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, d.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenant); err != nil {
			return err
		}
		return fn(tx)
	})
}

// Claim is a SECURITY DEFINER call that spends a row and returns its tenant, or no row.
// Only this package defines one, so every place a tenant is set can be read here.
type Claim struct{ sql string }

// EnrollmentToken spends an unused, unexpired enrollment token by its hash
// (api/migrations/0004_claim_enrollment_token.sql).
var EnrollmentToken = Claim{`SELECT t::text FROM claim_enrollment_token($1) t WHERE t IS NOT NULL`}

// Invite spends an unused, unexpired invite by its token's hash
// (api/migrations/0005_households_invites.sql).
var Invite = Claim{`SELECT t::text FROM claim_invite($1) t WHERE t IS NOT NULL`}

// InClaimedTenant is InTenant for a request whose tenant claim finds: no row is
// pgx.ErrNoRows and fn doesn't run. The claim is rolled back with fn's error.
func (d *DB) InClaimedTenant(
	ctx context.Context,
	claim Claim,
	arg any,
	fn func(tx pgx.Tx, tenant string) error,
) error {
	return pgx.BeginFunc(ctx, d.pool, func(tx pgx.Tx) error {
		var tenant string
		if err := tx.QueryRow(ctx, claim.sql, arg).Scan(&tenant); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenant); err != nil {
			return err
		}
		return fn(tx, tenant)
	})
}

// NoTenant is the pool itself, for the SECURITY DEFINER functions that run before the
// tenant is known (sign-in, the lookups that find it). Every table the API reads is empty through it.
func (d *DB) NoTenant() *pgxpool.Pool { return d.pool }
