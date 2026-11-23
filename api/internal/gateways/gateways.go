// Package gateways is the household's gateways: the list and DELETE /api/gateways/{id} (revoke).
package gateways

import (
	"net/http"
	"time"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

func Routes(mux *http.ServeMux, a *auth.Auth, d *db.DB, closeSockets func(gatewayID string)) {
	mux.HandleFunc("GET /api/gateways", a.Handler(false, func(w http.ResponseWriter, r *http.Request, c auth.Caller) {
		list(w, r, c, d)
	}))
	mux.HandleFunc(
		"DELETE /api/gateways/{id}",
		a.Handler(false, func(w http.ResponseWriter, r *http.Request, c auth.Caller) {
			revoke(w, r, c, d, closeSockets)
		}),
	)
}

// OnlineWindow: 3 missed 30 s heartbeats and a gateway is offline.
const OnlineWindow = 90 * time.Second
