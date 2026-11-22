package household

import (
	"net/http"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

// Created is POST /api/households' answer.
type Created struct {
	HouseholdID string `json:"householdId"`
}

// create: any signed-in user makes a household on purpose and becomes its admin, with
// or without one already (sign-up makes none). Unnamed until an admin names it.
func create(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB) {
	var out Created
	err := d.NoTenant().QueryRow(r.Context(), `SELECT create_household($1)::text`, c.User).Scan(&out.HouseholdID)
	writeJSON(w, out, err)
}
