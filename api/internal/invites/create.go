package invites

import (
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

// Created is POST /api/invites' answer: the token goes back this once (the web app puts
// it in the link).
type Created struct {
	ID        string    `json:"id"`
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// create: an admin's invite into the request's household.
func create(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB) {
	if c.Role != "admin" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	out := Created{Token: newToken()}
	err := d.InTenant(r.Context(), c.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(r.Context(), `INSERT INTO invites (id, tenant_id, token_hash, created_by, expires_at)
			VALUES (uuidv7(), $1, $2, $3, now() + interval '7 days') RETURNING id::text, expires_at`,
			c.Tenant, auth.HashSecret(out.Token), c.User).Scan(&out.ID, &out.ExpiresAt)
	})
	writeJSON(w, out, err)
}
