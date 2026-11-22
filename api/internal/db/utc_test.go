package db_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/apitest"
	"streamiq/api/internal/db"
)

// A timestamp read through the API's pool goes out as JSON in UTC (…Z), whatever the
// server's zone (time.Local) and the session's.
func TestTimestampsScanAsUTC(t *testing.T) {
	local := time.Local
	time.Local = time.FixedZone("UTC+5", 5*60*60)
	t.Cleanup(func() { time.Local = local })
	d, err := db.Connect(t.Context(), apitest.AppConfig(t)) // a pool made in this zone
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	var at time.Time
	err = d.InTenant(t.Context(), "00000000-0000-0000-0000-000000000001", func(tx pgx.Tx) error {
		if _, err := tx.Exec(t.Context(), `SET LOCAL TIME ZONE 'America/New_York'`); err != nil {
			return err
		}
		return tx.QueryRow(t.Context(), `SELECT timestamptz '2026-11-22 10:00:00+00'`).Scan(&at)
	})
	b, _ := json.Marshal(at)
	if err != nil || string(b) != `"2026-11-22T10:00:00Z"` {
		t.Fatalf("%s, %v", b, err)
	}
}
