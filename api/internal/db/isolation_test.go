package db_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"streamiq/api/internal/apitest"
	"streamiq/api/internal/db"
)

func TestMain(m *testing.M) { os.Exit(apitest.Run(m)) }

var tenantOwned = []string{"memberships", "gateways", "enrollment_tokens", "invites", "tunnels", "gateway_health"}

// seed gives a new household one row in every tenant-owned table, as the owner.
func seed(t *testing.T) string {
	t.Helper()
	user := apitest.Scalar[string](
		t,
		`INSERT INTO users ("Id", "FirebaseUid") VALUES (uuidv7(), uuidv7()::text) RETURNING "Id"::text`,
	)
	h := apitest.Household(t, user, "admin")
	gw := apitest.Scalar[string](
		t,
		`INSERT INTO gateways ("Id", "TenantId", "Name") VALUES (uuidv7(), $1, 'nas') RETURNING "Id"::text`,
		h,
	)
	apitest.Exec(
		t,
		`INSERT INTO enrollment_tokens ("Id", "TenantId", "TokenHash", "ExpiresAt") VALUES (uuidv7(), $1, uuidv7()::text, now())`,
		h,
	)
	apitest.Exec(
		t,
		`INSERT INTO invites ("Id", "TenantId", "TokenHash", "ExpiresAt") VALUES (uuidv7(), $1, uuidv7()::text, now())`,
		h,
	)
	apitest.Exec(
		t,
		`INSERT INTO tunnels ("Id", "TenantId", "GatewayId", "Relay", "Ipv6") VALUES (uuidv7(), $1, $2, false, false)`,
		h,
		gw,
	)
	apitest.Exec(
		t,
		`INSERT INTO gateway_health ("Id", "TenantId", "GatewayId", "At", "Level") VALUES (uuidv7(), $1, $2, now(), 'ok')`,
		h,
		gw,
	)
	return h
}

var errRollback = errors.New("rollback")

// inTenant runs sql in a transaction of tenant that is always rolled back.
func inTenant(ctx context.Context, d *db.DB, tenant, sql string, args ...any) (rows int64, err error) {
	err = d.InTenant(ctx, tenant, func(tx pgx.Tx) error {
		tag, execErr := tx.Exec(ctx, sql, args...)
		rows = tag.RowsAffected()
		if execErr != nil {
			return execErr
		}
		return errRollback
	})
	if errors.Is(err, errRollback) {
		err = nil
	}
	return rows, err
}

func count(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, sql string, args ...any) int {
	var n int
	if err := q.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
		return -1
	}
	return n
}

// breaches is every isolation rule d breaks, with households a and b holding one row
// per tenant-owned table each.
func breaches(ctx context.Context, d *db.DB, a, b string) (out []string) {
	for _, table := range tenantOwned {
		q := func(sql string) string { return strings.ReplaceAll(sql, "{t}", `public.`+table) }
		if n := count(ctx, d.NoTenant(), q(`SELECT count(*) FROM {t}`)); n != 0 {
			out = append(out, fmt.Sprintf("%s: %d rows with no tenant set", table, n))
		}
		_ = d.InTenant(ctx, a, func(tx pgx.Tx) error {
			if n := count(ctx, tx, q(`SELECT count(*) FROM {t}`)); n != 1 {
				out = append(out, fmt.Sprintf("%s: a sees %d rows, want its 1", table, n))
			}
			return nil
		})
		for verb, sql := range map[string]string{
			"update": q(`UPDATE {t} SET "TenantId" = "TenantId" WHERE "TenantId" = $1`),
			"delete": q(`DELETE FROM {t} WHERE "TenantId" = $1`),
		} {
			if n, err := inTenant(ctx, d, a, sql, b); n != 0 || err != nil {
				out = append(out, fmt.Sprintf("%s: a can %s b's rows (%d, %v)", table, verb, n, err))
			}
		}
		if _, err := inTenant(ctx, d, a, q(`UPDATE {t} SET "TenantId" = $1`), b); err == nil {
			out = append(out, table+": a can move its row into b")
		}
		if _, err := inTenant(ctx, d, a, q(`ALTER TABLE {t} DISABLE ROW LEVEL SECURITY`)); err == nil {
			out = append(out, table+": a can switch row-level security off")
		}
	}
	if _, err := inTenant(ctx, d, a, `INSERT INTO gateways ("Id", "TenantId") VALUES (uuidv7(), $1)`, b); err == nil {
		out = append(out, "a can insert a row for b")
	}
	return append(out, householdBreaches(ctx, d, a, b)...)
}

// householdBreaches is every rule on tenants and users d breaks: a household sees and
// changes its own tenants row and reads its members, nothing more, and writes no user.
func householdBreaches(ctx context.Context, d *db.DB, a, b string) (out []string) {
	for _, table := range []string{"tenants", "users"} {
		if n := count(ctx, d.NoTenant(), `SELECT count(*) FROM public.`+table); n != 0 {
			out = append(out, fmt.Sprintf("%s: %d rows with no tenant set", table, n))
		}
	}
	_ = d.InTenant(ctx, a, func(tx pgx.Tx) error {
		if n := count(ctx, tx, `SELECT count(*) FROM tenants`); n != 1 {
			out = append(out, fmt.Sprintf("tenants: a sees %d rows, want its 1", n))
		}
		if n := count(ctx, tx, `SELECT count(*) FROM users`); n != 1 {
			out = append(out, fmt.Sprintf("users: a sees %d rows, want its 1 member", n))
		}
		return nil
	})
	for what, sql := range map[string]string{
		"read b's household":   `SELECT FROM tenants WHERE "Id" = $1`,
		"rename b's household": `UPDATE tenants SET "Name" = 'x' WHERE "Id" = $1`,
		"lock b's household":   `SELECT FROM tenants WHERE "Id" = $1 FOR NO KEY UPDATE`,
	} {
		if n, err := inTenant(ctx, d, a, sql, b); n != 0 || err != nil {
			out = append(out, fmt.Sprintf("a can %s (%d, %v)", what, n, err))
		}
	}
	var bUser string
	if err := apitest.Owner.QueryRow(ctx, `SELECT "UserId" FROM memberships WHERE "TenantId" = $1`, b).Scan(&bUser); err != nil {
		return append(out, err.Error())
	}
	if n, err := inTenant(ctx, d, a, `SELECT FROM users WHERE "Id" = $1`, bUser); n != 0 || err != nil {
		out = append(out, fmt.Sprintf("a can read b's member (%d, %v)", n, err))
	}
	for what, sql := range map[string]string{
		"insert a household":   `INSERT INTO tenants ("Id") VALUES (uuidv7())`,
		"delete its household": `DELETE FROM tenants WHERE "Id" = $1`,
		"insert a user":        `INSERT INTO users ("Id", "FirebaseUid") VALUES (uuidv7(), uuidv7()::text)`,
		"rename a user":        `UPDATE users SET "FirebaseUid" = uuidv7()::text WHERE "Id" IN (SELECT "UserId" FROM memberships WHERE "TenantId" = $1)`,
		"delete a user":        `DELETE FROM users WHERE "Id" IN (SELECT "UserId" FROM memberships WHERE "TenantId" = $1)`,
	} {
		args := []any{a}
		if !strings.Contains(sql, "$1") {
			args = nil
		}
		if _, err := inTenant(ctx, d, a, sql, args...); err == nil {
			out = append(out, "a can "+what)
		}
	}
	return out
}

func TestTenantIsolation(t *testing.T) {
	apitest.Reset(t)
	a, b := seed(t), seed(t)
	if got := breaches(t.Context(), apitest.DB, a, b); len(got) != 0 {
		t.Fatalf("as %s:\n%s", db.AppRole, strings.Join(got, "\n"))
	}
}

// The same rules connected as the tables' owner, which bypasses every policy: the
// reason the API never connects as it.
func TestTheOwnerRoleBreaksIsolation(t *testing.T) {
	apitest.Reset(t)
	a, b := seed(t), seed(t)
	cfg, err := pgxpool.ParseConfig(apitest.OwnerURL)
	if err != nil {
		t.Fatal(err)
	}
	owner, err := db.Connect(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	if got := breaches(t.Context(), owner, a, b); len(got) == 0 {
		t.Fatal("the owner role passed every isolation rule")
	}
}

func TestTheTenantDoesNotSurviveOnAPooledConnection(t *testing.T) {
	apitest.Reset(t)
	a := seed(t)
	cfg := apitest.AppConfig(t)
	cfg.MaxConns = 1 // every query below shares one connection
	one, err := db.Connect(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer one.Close()
	ctx := t.Context()
	for _, end := range []error{nil, errRollback} { // after a commit and after a rollback
		_ = one.InTenant(ctx, a, func(tx pgx.Tx) error {
			if n := count(ctx, tx, `SELECT count(*) FROM gateways`); n != 1 {
				t.Fatalf("a's transaction saw %d gateways", n)
			}
			return end
		})
		if n := count(ctx, one.NoTenant(), `SELECT count(*) FROM gateways`); n != 0 {
			t.Fatalf("after a's transaction (%v) the same connection saw %d gateways", end, n)
		}
	}
}

// A table with a tenant column and no policy fails here, before any data leaks.
func TestEveryTenantColumnHasAPolicy(t *testing.T) {
	rows, _ := apitest.Owner.Query(t.Context(), `
		SELECT c.relname FROM pg_class c
		JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'TenantId' AND NOT a.attisdropped
		WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND NOT (c.relrowsecurity AND EXISTS (
			SELECT FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname
			AND p.roles @> ARRAY['streamiq_app'::name] AND p.cmd = 'ALL'
			AND p.qual LIKE '%"TenantId" = app_tenant()%' AND p.with_check LIKE '%"TenantId" = app_tenant()%'))`)
	missing, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) != 0 {
		t.Fatalf("tenant-owned tables without a USING + WITH CHECK policy on TenantId: %v", missing)
	}
	if n := apitest.Scalar[int](t, `SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
		AND roles @> ARRAY['streamiq_app'::name] AND (
			tablename = 'tenants' AND cmd = 'ALL' AND qual LIKE '%"Id" = app_tenant()%' AND with_check LIKE '%"Id" = app_tenant()%'
			OR tablename = 'users' AND cmd = 'SELECT' AND qual LIKE '%memberships%')`); n != 2 {
		t.Fatalf("%d of the policies on tenants (its Id) and users (read only, its members), want 2", n)
	}
	if n := apitest.Scalar[int](
		t,
		`SELECT count(*) FROM pg_class WHERE relrowsecurity AND relnamespace = 'public'::regnamespace`,
	); n != len(
		tenantOwned,
	)+2 {
		t.Fatalf("%d tables with row-level security, want %d (+ tenants, users)", n, len(tenantOwned))
	}
}

// memberships_of runs past RLS: it returns the user's own memberships and nobody else's.
func TestMembershipsOfReturnsOnlyTheUsersOwn(t *testing.T) {
	apitest.Reset(t)
	seed(t)
	seed(t)
	user := apitest.Scalar[string](t, `SELECT "UserId"::text FROM memberships LIMIT 1`)
	if n := count(t.Context(), apitest.DB.NoTenant(), `SELECT count(*) FROM memberships_of($1)`, user); n != 1 {
		t.Fatalf("memberships_of returned %d rows, want the user's 1", n)
	}
}
