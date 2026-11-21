package server

import (
	"context"
	"crypto/rand"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DB is the API's pool, connected as streamiq_app: row-level security hides every
// tenant-owned row unless the transaction names its tenant.
type DB struct{ pool *pgxpool.Pool }

func OpenDB(ctx context.Context, appURL string) (*DB, error) {
	pool, err := pgxpool.New(ctx, appURL)
	if err != nil {
		return nil, err
	}
	return &DB{pool}, pool.Ping(ctx)
}

func (d *DB) Close() { d.pool.Close() }

// InTenant runs fn in a transaction that sees tenant's rows only. The setting is
// transaction-local (set_config's third argument), so it never outlives the
// transaction on its pooled connection.
func (d *DB) InTenant(ctx context.Context, tenant string, fn func(pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, d.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenant); err != nil {
			return err
		}
		return fn(tx)
	})
}

// NoTenant is the pool itself: users (not tenant-owned) and the SECURITY DEFINER
// lookups. Any tenant-owned table reads as empty through it.
func (d *DB) NoTenant() *pgxpool.Pool { return d.pool }

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:]) // never fails (crypto/rand, Go 1.24+)
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
