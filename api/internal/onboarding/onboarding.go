// Package onboarding adds a gateway to a household: an admin mints a one-time enrollment
// token (POST /api/gateways/enrollment-tokens), the gateway spends it for its row and its
// long-lived credential (POST /api/gateways/enroll). Both spend the client IP's budget.
package onboarding

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"time"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
	"streamiq/api/internal/iplimit"
)

// Install is where the install command points: PublicURL (STREAMIQ_PUBLIC_URL) when set,
// else the URL the request came in on; Dev runs the gateway from source.
type Install struct {
	PublicURL string
	Dev       bool
}

func Routes(mux *http.ServeMux, a *auth.Auth, d *db.DB, ips *iplimit.Limiter, in Install) {
	mux.HandleFunc("POST /api/gateways/enrollment-tokens", ips.Wrap(a.Handler(false,
		func(w http.ResponseWriter, r *http.Request, c auth.Caller) { createToken(w, r, c, d, in) })))
	mux.HandleFunc("POST /api/gateways/enroll", ips.Wrap(func(w http.ResponseWriter, r *http.Request) {
		enroll(w, r, d)
	}))
}

// newSecret is n random bytes, URL-safe.
func newSecret(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// hash is how a secret is stored: SHA-256 hex, never the plaintext. The same as
// broker.Hash, which checks the credential on the gateway socket.
func hash(secret string) string {
	h := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(h[:])
}

// TokenLifetime is how long an enrollment token can be spent.
const TokenLifetime = 15 * time.Minute
