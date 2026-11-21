// Package gateways is the household's gateways: DELETE /api/gateways/{id} (revoke).
package gateways

import (
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/broker"
	"streamiq/api/internal/db"
)

func Routes(mux *http.ServeMux, a *auth.Auth, d *db.DB, b *broker.Broker) {
	mux.HandleFunc(
		"DELETE /api/gateways/{id}",
		a.Handler(false, func(w http.ResponseWriter, r *http.Request, c auth.Caller) {
			revoke(w, r, c, d, b)
		}),
	)
}

// revoke removes a gateway: its credential stops working at once, its socket and every
// session through it are closed. ponytail: revoked = credential hash nulled, row kept,
// so its tunnel rows survive (they cascade on a gateway delete). Re-adding the box =
// delete its state/gateway.json and enroll again.
func revoke(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB, b *broker.Broker) {
	if c.Role != "admin" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	var n int64
	// Another household's gateway is no row in this one's transaction: 404.
	err = d.InTenant(r.Context(), c.Tenant, func(tx pgx.Tx) error {
		tag, e := tx.Exec(r.Context(),
			`UPDATE gateways SET "CredentialHash" = NULL WHERE "Id" = $1 AND "CredentialHash" IS NOT NULL`, id)
		n = tag.RowsAffected()
		return e
	})
	switch {
	case err != nil:
		http.Error(w, "", http.StatusInternalServerError)
	case n == 0:
		w.WriteHeader(http.StatusNotFound)
	default:
		b.Revoke(id.String())
		w.WriteHeader(http.StatusNoContent)
	}
}
