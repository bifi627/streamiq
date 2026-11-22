package tunnels

import (
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

// Tunnel is a row of GET /api/tunnels. Null = not reported (yet).
type Tunnel struct {
	ID             string     `json:"id"`
	CreatedAt      time.Time  `json:"createdAt"`
	EndedAt        *time.Time `json:"endedAt"`
	GatewayID      string     `json:"gatewayId"`
	GatewayName    *string    `json:"gatewayName"`
	Relay          bool       `json:"relay"`
	IPv6           bool       `json:"ipv6"`
	BytesSent      *int64     `json:"bytesSent"`
	BytesReceived  *int64     `json:"bytesReceived"`
	ThroughputKbps *int       `json:"throughputKbps"`
	Failure        *string    `json:"failure"`
	Use            *string    `json:"use"`
	ActiveMs       *int64     `json:"activeMs"`
	// UserID: household scope only; absent there = a deleted account.
	UserID *string `json:"userId,omitempty"`
}

// list is the caller's own tunnels in the request's household, or with
// ?scope=household (admin only) every member's plus their userId: the last Window,
// newest first, at most Limit. Revoked gateways keep their row, so their name too.
func list(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB) {
	scope := r.URL.Query()["scope"]
	household := len(scope) > 0 && scope[0] == "household"
	switch {
	case len(scope) > 0 && !household:
		w.WriteHeader(http.StatusBadRequest)
		return
	case household && c.Role != "admin":
		w.WriteHeader(http.StatusForbidden)
		return
	}
	out := []Tunnel{}
	err := d.InTenant(r.Context(), c.Tenant, func(tx pgx.Tx) error {
		rows, _ := tx.Query(r.Context(), `SELECT t."Id"::text, t."CreatedAt", t."EndedAt", g."Id"::text, g."Name",
			t."Relay", t."Ipv6", t."BytesSent", t."BytesReceived", t."ThroughputKbps", t."Failure", t."Use",
			t."ActiveMs", CASE WHEN $1 THEN t."UserId"::text END
			FROM tunnels t JOIN gateways g ON g."Id" = t."GatewayId"
			WHERE ($1 OR t."UserId" = $2) AND t."CreatedAt" > now() - $3::interval
			ORDER BY t."CreatedAt" DESC LIMIT $4`, household, c.User, Window, Limit)
		var err error
		out, err = pgx.AppendRows(out, rows, func(row pgx.CollectableRow) (t Tunnel, err error) {
			err = row.Scan(&t.ID, &t.CreatedAt, &t.EndedAt, &t.GatewayID, &t.GatewayName, &t.Relay, &t.IPv6,
				&t.BytesSent, &t.BytesReceived, &t.ThroughputKbps, &t.Failure, &t.Use, &t.ActiveMs, &t.UserID)
			t.CreatedAt = t.CreatedAt.UTC()
			if t.EndedAt != nil {
				*t.EndedAt = t.EndedAt.UTC()
			}
			return t, err
		})
		return err
	})
	writeJSON(w, out, err)
}
