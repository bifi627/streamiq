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
	apitest.Exec(t, `INSERT INTO tunnels ("Id", "TenantId", "GatewayId", "Relay", "Ipv6", "EndedAt")
		SELECT uuidv7(), "TenantId", "GatewayId", false, false, '2026-01-01Z' FROM tunnels WHERE "TenantId" = $1`, h)
	start := apitest.Scalar[time.Time](t, `SELECT now()`)
	d, err := apitest.Open(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	d.Close()
	got := apitest.Scalar[string](t, `SELECT string_agg(
		("EndedAt" >= $1)::text || ("EndedAt" = '2026-01-01Z')::text, ',' ORDER BY "EndedAt") FROM tunnels`, start)
	if got != "falsetrue,truefalse" {
		t.Fatal(got)
	}
}
