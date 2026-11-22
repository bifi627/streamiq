package tunnels

import (
	"net/http"

	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

// Summary is a row of GET /api/tunnels/summary: one user's last Window.
type Summary struct {
	// UserID null = deleted accounts.
	UserID  *string `json:"userId"`
	Tunnels int     `json:"tunnels"`
	// Hidden: management or diagnostics that didn't fail, the rows Activity hides by default.
	Hidden int `json:"hidden"`
	Failed int `json:"failed"`
	// RelayedBytes: both directions of every relay row, whatever its use: what the relay costs.
	RelayedBytes int64 `json:"relayedBytes"`
}

// summary is per user of the request's household (admin only), over every tunnel of the
// last Window, not capped at Limit; most tunnels first.
func summary(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB) {
	if c.Role != "admin" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	out := []Summary{}
	err := d.InTenant(r.Context(), c.Tenant, func(tx pgx.Tx) error {
		rows, _ := tx.Query(r.Context(), `SELECT "UserId"::text, count(*),
			count(*) FILTER (WHERE "Use" IN ('management', 'diagnostics') AND "Failure" IS NULL),
			count(*) FILTER (WHERE "Failure" IS NOT NULL),
			coalesce(sum(coalesce("BytesSent", 0) + coalesce("BytesReceived", 0)) FILTER (WHERE "Relay"), 0)
			FROM tunnels WHERE "CreatedAt" > now() - $1::interval
			GROUP BY "UserId" ORDER BY count(*) DESC`, Window)
		var err error
		out, err = pgx.AppendRows(out, rows, func(row pgx.CollectableRow) (s Summary, err error) {
			err = row.Scan(&s.UserID, &s.Tunnels, &s.Hidden, &s.Failed, &s.RelayedBytes)
			return s, err
		})
		return err
	})
	writeJSON(w, out, err)
}
