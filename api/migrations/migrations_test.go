package migrations_test

import (
	"os"
	"testing"

	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/apitest"
	"streamiq/api/migrations"
)

func TestMain(m *testing.M) { os.Exit(apitest.Run(m)) }

func applied(t *testing.T, url string) []string {
	t.Helper()
	conn, err := pgx.Connect(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(t.Context()) }()
	rows, _ := conn.Query(t.Context(), `SELECT name FROM schema_migrations ORDER BY name`)
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	return names
}

func want(t *testing.T, got []string) {
	t.Helper()
	if len(got) != 2 || got[0] != "0001_baseline.sql" || got[1] != "0002_rls.sql" {
		t.Fatalf("applied %v", got)
	}
}

func TestEmptyDatabaseGetsEveryFileOnce(t *testing.T) {
	url := apitest.NewDatabase(t)
	for range 2 { // the second run finds nothing to do
		if err := migrations.Up(t.Context(), url); err != nil {
			t.Fatal(err)
		}
	}
	want(t, applied(t, url))
	conn, err := pgx.Connect(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(t.Context()) }()
	var efRows int // the .NET API, started after, finds its migrations applied
	if err := conn.QueryRow(t.Context(), `SELECT count(*) FROM "__EFMigrationsHistory"`).
		Scan(&efRows); err != nil ||
		efRows == 0 {
		t.Fatalf("EF history: %d rows, %v", efRows, err)
	}
}

// A database EF migrated: today's schema and EF's history, no schema_migrations. Running
// the baseline again would fail on its first CREATE TABLE.
func TestEFMigratedDatabaseAdoptsTheBaseline(t *testing.T) {
	url := apitest.NewDatabase(t)
	baseline, err := os.ReadFile("0001_baseline.sql")
	if err != nil {
		t.Fatal(err)
	}
	conn, err := pgx.Connect(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(t.Context()) }()
	if _, err := conn.PgConn().Exec(t.Context(), string(baseline)).ReadAll(); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(t.Context(), `INSERT INTO tenants ("Id", "Name") VALUES (uuidv7(), 'kept')`); err != nil {
		t.Fatal(err)
	}

	if err := migrations.Up(t.Context(), url); err != nil {
		t.Fatal(err)
	}
	want(t, applied(t, url))
	var name string
	if err := conn.QueryRow(t.Context(), `SELECT "Name" FROM tenants`).Scan(&name); err != nil || name != "kept" {
		t.Fatalf("tenant after adopting: %q, %v", name, err)
	}
}
