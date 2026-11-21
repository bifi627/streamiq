// Package migrations applies the plain SQL files in this directory, in name order,
// each once and in its own transaction.
package migrations

import (
	"context"
	"embed"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"
)

//go:embed *.sql
var files embed.FS

const baseline = "0001_baseline.sql"

// Up runs every file not applied yet, as the role in url (the tables' owner). On a
// database EF Core already migrated, the baseline is recorded instead of run.
// Its own connection, closed after: the pg_dump baseline empties search_path for the session.
func Up(ctx context.Context, url string) error {
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	// ponytail: one API instance. A second one needs pg_advisory_lock around this.
	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	entries, _ := files.ReadDir(".")
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, e := range entries {
		name := e.Name()
		var done, adopted bool
		if err := conn.QueryRow(ctx, `SELECT EXISTS (SELECT FROM public.schema_migrations WHERE name = $1), to_regclass('public.tenants') IS NOT NULL`, name).Scan(&done, &adopted); err != nil {
			return err
		}
		if done {
			continue
		}
		sql, _ := files.ReadFile(name)
		err := pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
			if name != baseline || !adopted {
				if _, err := tx.Conn().PgConn().Exec(ctx, string(sql)).ReadAll(); err != nil {
					return err
				}
			}
			_, err := tx.Exec(ctx, `INSERT INTO public.schema_migrations (name) VALUES ($1)`, name)
			return err
		})
		if err != nil {
			return fmt.Errorf("migration %s: %w", name, err)
		}
	}
	return nil
}
