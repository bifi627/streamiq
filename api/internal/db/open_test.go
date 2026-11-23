package db_test

import (
	"strings"
	"testing"

	"streamiq/api/internal/db"
)

// The API refuses to start without the app role's password, before it touches the database.
func TestOpenNeedsTheAppPassword(t *testing.T) {
	_, err := db.Open(t.Context(), "postgres://nowhere.invalid/streamiq", "")
	if err == nil || !strings.Contains(err.Error(), "STREAMIQ_APP_DB_PASSWORD") {
		t.Fatalf("got %v", err)
	}
}
