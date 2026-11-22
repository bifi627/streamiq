package gateways

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/broker"
	"streamiq/api/internal/db"
)

// Gateway is a row of GET /api/gateways: liveness and the telemetry level; the details
// come from the gateway API over the tunnel.
type Gateway struct {
	ID         string     `json:"id"`
	Name       *string    `json:"name"`
	LastSeenAt *time.Time `json:"lastSeenAt"`
	LanURL     *string    `json:"lanUrl"`
	Version    *string    `json:"version"`
	// Update is a newer gateway release; null = up to date.
	Update *string `json:"update"`
	// Telemetry is health sharing, from the heartbeat; null = a gateway too old to send it.
	Telemetry *string `json:"telemetry" tstype:"'off' | 'full' | null"`
	Online    bool    `json:"online"`
	// UpgradeRequired: refused, its protocol is below the API's minimum.
	UpgradeRequired bool `json:"upgradeRequired"`
}

// list is the household's gateways, oldest first; revoked ones are hidden.
func list(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB) {
	out := []Gateway{}
	err := d.InTenant(r.Context(), c.Tenant, func(tx pgx.Tx) error {
		rows, _ := tx.Query(r.Context(), `SELECT id::text, name, last_seen_at, lan_url, version, update,
			telemetry, coalesce(last_seen_at > now() - $1::interval, false), coalesce(protocol < $2, false)
			FROM gateways WHERE credential_hash IS NOT NULL ORDER BY created_at`,
			OnlineWindow, broker.MinGatewayProtocol)
		var err error
		out, err = pgx.AppendRows(out, rows, func(row pgx.CollectableRow) (g Gateway, err error) {
			err = row.Scan(&g.ID, &g.Name, &g.LastSeenAt, &g.LanURL, &g.Version, &g.Update,
				&g.Telemetry, &g.Online, &g.UpgradeRequired)
			return g, err
		})
		return err
	})
	writeJSON(w, out, err)
}

func writeJSON(w http.ResponseWriter, v any, err error) {
	if err != nil {
		http.Error(w, "", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}
