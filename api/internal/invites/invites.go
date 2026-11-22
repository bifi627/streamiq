// Package invites is joining a household by link: an admin creates, lists and revokes
// single-use invites (7 days); preview and accept are the way in for a signed-in user,
// with or without a household. The token is stored only as its SHA-256 and travels in
// request bodies, never in a URL (logs).
package invites

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"slices"

	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
	"streamiq/api/internal/iplimit"
)

func Routes(mux *http.ServeMux, a *auth.Auth, d *db.DB, ips *iplimit.Limiter) {
	mux.HandleFunc("POST /api/invites", ips.Wrap(a.Handler(false,
		func(w http.ResponseWriter, r *http.Request, c auth.Caller) { create(w, r, c, d) })))
	mux.HandleFunc("GET /api/invites", a.Handler(false,
		func(w http.ResponseWriter, r *http.Request, c auth.Caller) { list(w, r, c, d) }))
	mux.HandleFunc("DELETE /api/invites/{id}", a.Handler(false,
		func(w http.ResponseWriter, r *http.Request, c auth.Caller) { revoke(w, r, c, d) }))
	mux.HandleFunc("POST /api/invites/preview", a.Handler(true,
		func(w http.ResponseWriter, r *http.Request, c auth.Caller) { preview(w, r, c, d, a) }))
	mux.HandleFunc("POST /api/invites/accept", a.Handler(true,
		func(w http.ResponseWriter, r *http.Request, c auth.Caller) { accept(w, r, c, d) }))
}

// hash is how a token is stored: SHA-256 hex, never the plaintext.
func hash(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

func newToken() string {
	b := make([]byte, 16) // 128 bit
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// token is the request body's token ("" when none); ok false for a body that isn't JSON.
func token(w http.ResponseWriter, r *http.Request) (string, bool) {
	var rq struct{ Token string }
	err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&rq)
	return rq.Token, err == nil
}

type found struct {
	household  string
	usable     bool
	name       *string
	inviterUID *string
}

// find is a token's invite, from any household: the token is what establishes it.
// Unknown or revoked: ok false.
func find(r *http.Request, d *db.DB, token string) (f found, ok bool, err error) {
	if token == "" {
		return f, false, nil
	}
	err = d.NoTenant().QueryRow(r.Context(), `SELECT tenant_id::text, usable, name, inviter_uid
		FROM invite_by_hash($1)`, hash(token)).Scan(&f.household, &f.usable, &f.name, &f.inviterUID)
	if errors.Is(err, pgx.ErrNoRows) {
		return f, false, nil
	}
	return f, err == nil, err
}

// member is whether the caller is in household now (Households is read per request).
func member(c auth.Caller, household string) bool {
	return slices.ContainsFunc(c.Households, func(h auth.Household) bool { return h.ID == household })
}

func writeJSON(w http.ResponseWriter, v any, err error) {
	if err != nil {
		http.Error(w, "", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}
