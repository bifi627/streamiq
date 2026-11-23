// Package relayusage is how many bytes each gateway relayed through Cloudflare TURN per
// UTC month: Job copies them from Cloudflare's analytics, GET /api/relay-usage
// shows them to the household's admin.
package relayusage

import (
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

func Routes(mux *http.ServeMux, a *auth.Auth, d *db.DB) {
	mux.HandleFunc(
		"GET /api/relay-usage",
		a.Handler(false, func(w http.ResponseWriter, r *http.Request, c auth.Caller) {
			get(w, r, c, d)
		}),
	)
}

// Usage is a row of GET /api/relay-usage: one gateway's relayed bytes (TURN egress),
// this UTC month and the previous one.
type Usage struct {
	GatewayID string  `json:"gatewayId"`
	Name      *string `json:"name"`
	// Removed: the gateway was removed (revoked) since.
	Removed   bool  `json:"removed"`
	ThisMonth int64 `json:"thisMonth"`
	LastMonth int64 `json:"lastMonth"`
}

// get is the claimed household's rows (admin only), most this month first.
func get(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB) {
	if c.Role != "admin" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	out := []Usage{}
	err := d.InTenant(r.Context(), c.Tenant, func(tx pgx.Tx) error {
		rows, _ := tx.Query(r.Context(), `SELECT u.gateway_id::text, g.name, g.credential_hash IS NULL,
			coalesce(sum(u.bytes) FILTER (WHERE u.month = date_trunc('month', now() AT TIME ZONE 'UTC')), 0)::bigint,
			coalesce(sum(u.bytes) FILTER (WHERE u.month < date_trunc('month', now() AT TIME ZONE 'UTC')), 0)::bigint
			FROM relay_usage u LEFT JOIN gateways g ON g.id = u.gateway_id
			WHERE u.month >= date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month'
			GROUP BY 1, 2, 3 ORDER BY 4 DESC, 5 DESC, 1`)
		var err error
		out, err = pgx.AppendRows(out, rows, func(row pgx.CollectableRow) (u Usage, err error) {
			err = row.Scan(&u.GatewayID, &u.Name, &u.Removed, &u.ThisMonth, &u.LastMonth)
			return u, err
		})
		return err
	})
	if err != nil {
		http.Error(w, "", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(out)
}
