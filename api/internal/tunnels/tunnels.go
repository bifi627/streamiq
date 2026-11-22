// Package tunnels is what the web app reads of the tunnels table (Activity) and the
// browser's one part of tunnel telemetry: the throughput it measured. The broker writes
// the rows.
package tunnels

import (
	"encoding/json"
	"net/http"
	"time"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

func Routes(mux *http.ServeMux, a *auth.Auth, d *db.DB) {
	mux.HandleFunc("GET /api/tunnels", a.Handler(false, func(w http.ResponseWriter, r *http.Request, c auth.Caller) {
		list(w, r, c, d)
	}))
	mux.HandleFunc("GET /api/tunnels/summary", a.Handler(false, func(w http.ResponseWriter, r *http.Request, c auth.Caller) {
		summary(w, r, c, d)
	}))
	mux.HandleFunc("PATCH /api/tunnels/{id}", a.Handler(false, func(w http.ResponseWriter, r *http.Request, c auth.Caller) {
		throughput(w, r, c, d)
	}))
}

// Window is how far back Activity reads; Limit caps the list (not the summary).
const (
	Window = 30 * 24 * time.Hour
	Limit  = 200
)

func writeJSON(w http.ResponseWriter, v any, err error) {
	if err != nil {
		http.Error(w, "", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}
