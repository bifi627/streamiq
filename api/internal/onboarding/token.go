package onboarding

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

// EnrollmentToken is POST /api/gateways/enrollment-tokens' answer: the token and the
// install commands that carry it.
type EnrollmentToken struct {
	Token                    string    `json:"token"`
	ExpiresAt                time.Time `json:"expiresAt"`
	InstallCommand           string    `json:"installCommand"`
	InstallCommandPowershell string    `json:"installCommandPowershell"`
}

const releases = "https://github.com/bifi627/streamiq/releases/latest/download"

// createToken is "Add gateway": an admin's one-time enrollment token for the household.
func createToken(w http.ResponseWriter, r *http.Request, c auth.Caller, d *db.DB, in Install) {
	if c.Role != "admin" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	t := EnrollmentToken{Token: newSecret(16), ExpiresAt: time.Now().Add(TokenLifetime).UTC()} // 128 bit
	err := d.InTenant(r.Context(), c.Tenant, func(tx pgx.Tx) error {
		_, err := tx.Exec(r.Context(), `INSERT INTO enrollment_tokens (id, tenant_id, token_hash, expires_at)
			VALUES (uuidv7(), $1, $2, $3)`, c.Tenant, hash(t.Token), t.ExpiresAt)
		return err
	})
	if err != nil {
		http.Error(w, "", http.StatusInternalServerError)
		return
	}
	t.InstallCommand, t.InstallCommandPowershell = in.commands(apiURL(r, in.PublicURL), t.Token)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(t)
}

// commands: in development, run from source in gateway/; elsewhere the released binary
// through the install script (GitHub Releases; it also updates later).
func (in Install) commands(api, token string) (sh, ps string) {
	vars := "STREAMIQ_API_URL=" + api + " STREAMIQ_ENROLL_TOKEN=" + token
	psVars := "$env:STREAMIQ_API_URL='" + api + "'; $env:STREAMIQ_ENROLL_TOKEN='" + token + "';"
	if in.Dev {
		return vars + " go run ./cmd/gateway", psVars + " go run ./cmd/gateway"
	}
	return "curl -fsSL " + releases + "/install.sh | " + vars + " sh", psVars + " irm " + releases + "/install.ps1 | iex"
}

// apiURL is public when set, else the URL the request came in on: https behind a
// TLS-terminating proxy (Railway's sets X-Forwarded-Proto).
func apiURL(r *http.Request, public string) string {
	if public != "" {
		return strings.TrimRight(public, "/")
	}
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}
