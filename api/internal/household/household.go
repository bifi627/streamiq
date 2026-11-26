// Package household is a household (tenant) of its own: POST /api/households makes one,
// PUT /api/households/current/name names the request's, DELETE /api/households/current
// deletes it.
package household

import (
	"encoding/json"
	"net/http"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
	"streamiq/api/internal/iplimit"
)

func Routes(mux *http.ServeMux, a *auth.Auth, d *db.DB, ips *iplimit.Limiter, closeSockets func(gatewayID string)) {
	// A flood shield on tenant rows: the per-IP budget.
	mux.HandleFunc("POST /api/households", ips.Wrap(a.Handler(true,
		func(w http.ResponseWriter, r *http.Request, c auth.Caller) { create(w, r, c, d) })))
	mux.HandleFunc("PUT /api/households/current/name", a.Handler(false,
		func(w http.ResponseWriter, r *http.Request, c auth.Caller) { rename(w, r, c, d) }))
	mux.HandleFunc("DELETE /api/households/current", a.Handler(false,
		func(w http.ResponseWriter, r *http.Request, c auth.Caller) { remove(w, r, c, d, closeSockets) }))
}

func writeJSON(w http.ResponseWriter, v any, err error) {
	if err != nil {
		http.Error(w, "", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}
