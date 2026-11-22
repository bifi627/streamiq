package db_test

import (
	"strings"
	"testing"
	"time"

	"streamiq/api/internal/apitest"
	"streamiq/api/internal/db"
)

// The API refuses to start without the app role's password, before it touches the database.
func TestOpenNeedsTheAppPassword(t *testing.T) {
	_, err := db.Open(t.Context(), "postgres://nowhere.invalid/streamiq", "")
	if err == nil || !strings.Contains(err.Error(), "STREAMIQ_APP_DB_PASSWORD") {
		t.Fatalf("got %v", err)
	}
}

// A killed API leaves its open tunnels without an end: the next start ends them at its own
// start time, and leaves an ended one as it was.
func TestOpenEndsTheTunnelsAKilledProcessLeftOpen(t *testing.T) {
	apitest.Reset(t)
	h := seed(t)
	apitest.Exec(t, `INSERT INTO tunnels (id, tenant_id, gateway_id, relay, ipv6, ended_at)
		SELECT uuidv7(), tenant_id, gateway_id, false, false, '2026-01-01Z' FROM tunnels WHERE tenant_id = $1`, h)
	start := apitest.Scalar[time.Time](t, `SELECT now()`)
	d, err := apitest.Open(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	d.Close()
	got := apitest.Scalar[string](t, `SELECT string_agg(
		(ended_at >= $1)::text || (ended_at = '2026-01-01Z')::text, ',' ORDER BY ended_at) FROM tunnels`, start)
	if got != "falsetrue,truefalse" {
		t.Fatal(got)
	}
}
