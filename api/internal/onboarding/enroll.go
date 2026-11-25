package onboarding

import (
	"encoding/json"
	"errors"
	"net/http"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
)

// Enrolled is POST /api/gateways/enroll's answer; the credential is never shown again.
type Enrolled struct {
	GatewayID  string `json:"gatewayId"`
	Credential string `json:"credential"`
}

// enroll spends an enrollment token: the gateway's row in the token's household, with
// and its credential. No sign-in: the token is the auth.
func enroll(w http.ResponseWriter, r *http.Request, d *db.DB) {
	var rq struct{ Token, Name string } // an older gateway also sends a fingerprint: ignored
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&rq) != nil || rq.Token == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	out := Enrolled{Credential: newSecret(32)} // 256 bit
	// Claim and row in one transaction: an enrollment that fails after the claim keeps the token.
	err := d.InClaimedTenant(r.Context(), db.EnrollmentToken, auth.HashSecret(rq.Token),
		func(tx pgx.Tx, tenant string) error {
			return tx.QueryRow(r.Context(), `INSERT INTO gateways (id, tenant_id, name, credential_hash)
				VALUES (uuidv7(), $1, $2, $3) RETURNING id::text`,
				tenant, name(rq.Name), auth.HashSecret(out.Credential)).
				Scan(&out.GatewayID)
		})
	switch {
	case errors.Is(err, pgx.ErrNoRows): // spent, expired or unknown
		w.WriteHeader(http.StatusUnauthorized)
	case err != nil:
		http.Error(w, "", http.StatusInternalServerError)
	default:
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(out)
	}
}

// name is the gateway's name cut to 100 UTF-16 units (an emoji counts 2, as in the
// gateway's own rename: docs/protocol.md), never inside a character; "gateway" when none is sent.
func name(n string) string {
	if n == "" {
		return "gateway"
	}
	units := 0
	for i, r := range n {
		if units += utf16.RuneLen(r); units > 100 {
			return n[:i]
		}
	}
	return n
}
