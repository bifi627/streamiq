package migrations_test

import (
	"context"
	"os"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/apitest"
	"streamiq/api/migrations"
)

func TestMain(m *testing.M) { os.Exit(apitest.Run(m)) }

func connect(t *testing.T, url string) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	return conn
}

// rows is a query's rows as text, one per line.
func rows(t *testing.T, conn *pgx.Conn, sql string) string {
	t.Helper()
	var s string
	if err := conn.QueryRow(t.Context(), `SELECT coalesce(string_agg(x::text, E'\n'), '') FROM (`+sql+`) x`).
		Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

func want(t *testing.T, conn *pgx.Conn) {
	wantTo(t, conn, "\n(0008_relay_usage.sql)\n(0009_drop_tunnel_telemetry.sql)")
}

// wantTo: every file up to 0007 was applied, then rest.
func wantTo(t *testing.T, conn *pgx.Conn, rest string) {
	t.Helper()
	got := rows(t, conn, `SELECT name FROM schema_migrations ORDER BY name`)
	if got != "(0001_baseline.sql)\n(0002_rls.sql)\n(0003_gateway_by_credential.sql)\n"+
		"(0004_claim_enrollment_token.sql)\n(0005_households_invites.sql)\n(0006_rls_tenants_users.sql)\n"+
		"(0007_snake_case.sql)"+rest {
		t.Fatalf("applied %v", got)
	}
}

// snakeCase: no name in public has an upper-case letter, no function body quotes one, and
// EF's history table is gone.
func snakeCase(t *testing.T, conn *pgx.Conn) {
	t.Helper()
	if upper := rows(t, conn, `
		SELECT c.relname || '.' || a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
		  WHERE c.relnamespace = 'public'::regnamespace AND a.attnum > 0 AND a.attname ~ '[A-Z]'
		UNION ALL SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname ~ '[A-Z]'
		UNION ALL SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname ~ '[A-Z]'
		UNION ALL SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
		  AND (proname ~ '[A-Z]' OR prosrc LIKE '%"%')`); upper != "" {
		t.Fatalf("upper-case names left:\n%s", upper)
	}
}

func TestEmptyDatabaseGetsEveryFileOnce(t *testing.T) {
	url := apitest.NewDatabase(t)
	for range 2 { // the second run finds nothing to do
		if err := migrations.Up(t.Context(), url); err != nil {
			t.Fatal(err)
		}
	}
	conn := connect(t, url)
	want(t, conn)
	snakeCase(t, conn)
}

// A database EF migrated (a backup from before the cutover): today's schema and EF's
// history, no schema_migrations. Running the baseline again would fail on its first
// CREATE TABLE.
func TestEFMigratedDatabaseAdoptsTheBaseline(t *testing.T) {
	url := apitest.NewDatabase(t)
	baseline, err := os.ReadFile("0001_baseline.sql")
	if err != nil {
		t.Fatal(err)
	}
	conn := connect(t, url)
	if _, err := conn.PgConn().Exec(t.Context(), string(baseline)).ReadAll(); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(
		t.Context(),
		`INSERT INTO tenants SELECT * FROM json_populate_record(null::tenants, '{"Id": "0190a000-0000-7000-8000-000000000001", "Name": "kept", "CreatedAt": "2026-01-01T00:00:00Z"}')`,
	); err != nil {
		t.Fatal(err)
	}

	if err := migrations.Up(t.Context(), url); err != nil {
		t.Fatal(err)
	}
	want(t, conn)
	snakeCase(t, conn)
	var name string
	if err := conn.QueryRow(t.Context(), `SELECT name FROM tenants`).Scan(&name); err != nil || name != "kept" {
		t.Fatalf("tenant after adopting: %q, %v", name, err)
	}
}

// One row in every table, written by name before 0007 (JSON keys, so no quoted SQL).
var seed = map[string]string{
	"tenants":           `{"Id": "0190a000-0000-7000-8000-000000000001", "Name": "home", "CreatedAt": "2026-01-01T00:00:00Z"}`,
	"users":             `{"Id": "0190a000-0000-7000-8000-000000000002", "FirebaseUid": "uid-a", "CreatedAt": "2026-01-01T00:00:00Z"}`,
	"memberships":       `{"TenantId": "0190a000-0000-7000-8000-000000000001", "UserId": "0190a000-0000-7000-8000-000000000002", "Role": "admin", "CreatedAt": "2026-01-01T00:00:00Z"}`,
	"gateways":          `{"Id": "0190a000-0000-7000-8000-000000000003", "TenantId": "0190a000-0000-7000-8000-000000000001", "Name": "nas", "DtlsFingerprint": "sha-256 AA", "CredentialHash": "c1", "LastSeenAt": "2026-01-02T00:00:00Z", "CreatedAt": "2026-01-01T00:00:00Z", "LanUrl": "http://nas.lan", "Version": "1.2.0", "Update": "1.3.0", "Protocol": 3, "Telemetry": "full"}`,
	"enrollment_tokens": `{"Id": "0190a000-0000-7000-8000-000000000004", "TenantId": "0190a000-0000-7000-8000-000000000001", "TokenHash": "e1", "ExpiresAt": "2026-01-03T00:00:00Z", "UsedAt": "2026-01-02T00:00:00Z", "CreatedAt": "2026-01-01T00:00:00Z"}`,
	"invites":           `{"Id": "0190a000-0000-7000-8000-000000000005", "TenantId": "0190a000-0000-7000-8000-000000000001", "TokenHash": "i1", "CreatedBy": "0190a000-0000-7000-8000-000000000002", "ExpiresAt": "2026-01-03T00:00:00Z", "CreatedAt": "2026-01-01T00:00:00Z"}`,
	"tunnels":           `{"Id": "0190a000-0000-7000-8000-000000000006", "TenantId": "0190a000-0000-7000-8000-000000000001", "GatewayId": "0190a000-0000-7000-8000-000000000003", "Relay": true, "Ipv6": false, "LocalCandidateType": "relay", "RemoteCandidateType": "srflx", "Protocol": "udp", "BytesReceived": 10, "BytesSent": 20, "CreatedAt": "2026-01-01T00:00:00Z", "EndedAt": "2026-01-01T00:05:00Z", "Failure": "x", "ThroughputKbps": 900, "UserId": "0190a000-0000-7000-8000-000000000002", "ActiveMs": 4200, "Use": "playback"}`,
	"gateway_health":    `{"Id": "0190a000-0000-7000-8000-000000000007", "TenantId": "0190a000-0000-7000-8000-000000000001", "GatewayId": "0190a000-0000-7000-8000-000000000003", "At": "2026-01-01T00:00:00Z", "Level": "full", "JellyfinReachable": true, "JellyfinVersion": "10.11", "Os": "linux", "Arch": "amd64", "Transcoding": "ok", "Offline": "no", "Tunnels": 2, "Transcodes": 1, "Cpu": 0.5, "Memory": 0.25, "GatewayVersion": "1.2.0"}`,
}

// Rows, policies and privileges are the same before and after 0007 (names aside).
func TestSnakeCaseOnlyRenames(t *testing.T) {
	url := apitest.NewDatabase(t)
	if err := migrations.UpTo(t.Context(), url, "0006_rls_tenants_users.sql"); err != nil {
		t.Fatal(err)
	}
	conn := connect(t, url)
	tables := []string{
		"tenants", "users", "memberships", "gateways", "enrollment_tokens", "invites", "tunnels", "gateway_health",
	}
	for _, table := range tables { // in foreign-key order
		if _, err := conn.Exec(t.Context(),
			`INSERT INTO `+table+` SELECT * FROM json_populate_record(null::`+table+`, $1)`, seed[table]); err != nil {
			t.Fatal(table, err)
		}
	}
	state := func() []string {
		var s []string
		for _, table := range tables {
			s = append(s, rows(t, conn, `SELECT t::text FROM `+table+` t`))
		}
		return append(s,
			rows(t, conn, `SELECT relname, relrowsecurity, relforcerowsecurity, relacl FROM pg_class
				WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
				AND relname NOT IN ('schema_migrations', '__EFMigrationsHistory') ORDER BY 1`),
			rows(t, conn, `SELECT tablename, policyname, permissive, roles, cmd, qual IS NULL, with_check IS NULL
				FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2`),
			rows(t, conn, `SELECT proname, proowner::regrole, prosecdef, provolatile, proconfig, proacl,
				pg_get_function_arguments(oid), pg_get_function_result(oid)
				FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 1`),
		)
	}
	before := state()
	for _, s := range before[:len(tables)] {
		if s == "" {
			t.Fatal("a table has no row")
		}
	}

	if err := migrations.UpTo(t.Context(), url, "0007_snake_case.sql"); err != nil {
		t.Fatal(err)
	}
	if after := state(); !slices.Equal(before, after) {
		t.Fatalf("changed:\nbefore %q\nafter  %q", before, after)
	}
	wantTo(t, conn, "")
	snakeCase(t, conn)
}
