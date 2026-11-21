package gateways

import (
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

// HealthRow is a gateway_health row as GET /api/gateways/{id}/health reads it. Null = not sent.
type HealthRow struct {
	At                time.Time `json:"at"`
	JellyfinReachable *bool     `json:"jellyfinReachable"`
	JellyfinVersion   *string   `json:"jellyfinVersion"`
	GatewayVersion    *string   `json:"gatewayVersion"`
	Tunnels           *int      `json:"tunnels"`
	Transcodes        *int      `json:"transcodes"`
	CPU               *float64  `json:"cpu"`
	Memory            *float64  `json:"memory"`
}

// health is a gateway's rows of the last HealthWindow, oldest first, led by the latest
// row before it (the state the window starts in). The browser derives incidents,
// versions and daily peaks: local days need its time zone. ponytail: raw rows (≤ 288 a
// day), aggregate in SQL if the response gets heavy.
func health(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	var out []HealthRow
	err = d.InTenant(r.Context(), c.Tenant, func(tx pgx.Tx) error {
		// Another household's gateway is no row in this one's transaction: 404, like an unknown id.
		var known bool
		if err := tx.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM gateways WHERE "Id" = $1)`, id).
			Scan(&known); err != nil || !known {
			return errors.Join(err, pgx.ErrNoRows)
		}
		rows, _ := tx.Query(r.Context(), `SELECT `+healthCols+` FROM gateway_health WHERE "GatewayId" = $1
			AND "At" >= coalesce((SELECT max("At") FROM gateway_health
				WHERE "GatewayId" = $1 AND "At" < now() - $2::interval), now() - $2::interval)
			ORDER BY "At"`, id, HealthWindow)
		out, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (h HealthRow, err error) {
			err = row.Scan(&h.At, &h.JellyfinReachable, &h.JellyfinVersion, &h.GatewayVersion,
				&h.Tunnels, &h.Transcodes, &h.CPU, &h.Memory)
			return h, err
		})
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	writeJSON(w, out, err)
}

const healthCols = `"At", "JellyfinReachable", "JellyfinVersion", "GatewayVersion", "Tunnels", "Transcodes", "Cpu", "Memory"`
