package invites

import (
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

// Invite is a pending invite of GET /api/invites.
type Invite struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// list: the household's pending invites (unused, unexpired), oldest first.
// ponytail: used and expired rows stay in the table; prune them if it ever matters.
func list(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB) {
	if c.Role != "admin" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	out := []Invite{}
	err := d.InTenant(r.Context(), c.Tenant, func(tx pgx.Tx) error {
		rows, _ := tx.Query(r.Context(), `SELECT "Id"::text, "CreatedAt", "ExpiresAt" FROM invites
			WHERE "UsedAt" IS NULL AND "ExpiresAt" > now() ORDER BY "CreatedAt", "Id"`)
		var err error
		out, err = pgx.AppendRows(out, rows, pgx.RowToStructByPos[Invite])
		return err
	})
	writeJSON(w, out, err)
}
