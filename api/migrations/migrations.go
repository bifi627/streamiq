// Package migrations applies the plain SQL files in this directory, in name order,
// each once and in its own transaction.
package migrations

import (
	"context"
	"embed"
	"fmt"

	"github.com/jackc/pgx/v5"
)

//go:embed *.sql
var files embed.FS

const baseline = "0001_baseline.sql"

// Up runs every file not applied yet, as the role in url, which owns the tables. On a
// database EF Core migrated (its history table exists: a backup from before the cutover),
// the baseline is recorded instead of run, and 0007 drops that table. Its own connection,
// closed after, so nothing a file sets for its session reaches the API's pool.
// ponytail: one API instance migrates; a second needs pg_advisory_lock around this.
func Up(ctx context.Context, url string) error { return upTo(ctx, url, "") }

// upTo stops after the file named last ("" = none).
func upTo(ctx context.Context, url, last string) error {
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close(ctx) }()
	if _, err = conn.Exec(
		ctx,
		`CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
	); err != nil {
		return err
	}
	entries, err := files.ReadDir(".") // sorted by name
	if err != nil {
		return err
	}
	for _, e := range entries {
		if err = apply(ctx, conn, e.Name()); err != nil {
			return fmt.Errorf("migration %s: %w", e.Name(), err)
		}
		if e.Name() == last {
			break
		}
	}
	return nil
}

func apply(ctx context.Context, conn *pgx.Conn, name string) error {
	var done, adopt bool
	err := conn.QueryRow(ctx, `SELECT EXISTS (SELECT FROM public.schema_migrations WHERE name = $1),
		$1 = $2 AND to_regclass('public."__EFMigrationsHistory"') IS NOT NULL`, name, baseline).Scan(&done, &adopt)
	if err != nil || done {
		return err
	}
	sql, err := files.ReadFile(name)
	if err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		if !adopt {
			// The simple protocol: a file holds many statements and no parameters.
			if _, err := tx.Conn().PgConn().Exec(ctx, string(sql)).ReadAll(); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `INSERT INTO public.schema_migrations (name) VALUES ($1)`, name)
		return err
	})
}
