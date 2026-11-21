package onboarding

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"

	"streamiq/api/internal/db"
)

// Enrolled is POST /api/gateways/enroll's answer; the credential is never shown again.
type Enrolled struct {
	GatewayID  string `json:"gatewayId"`
	Credential string `json:"credential"`
}

// fingerprintRe is `sha-256 AA:BB:…`, 32 upper-case hex pairs: the form in docs/protocol.md.
var fingerprintRe = regexp.MustCompile(`^sha-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}$`)

// enroll spends an enrollment token: the gateway's row in the token's household, with
// its pinned DTLS fingerprint, and its credential. No sign-in: the token is the auth.
func enroll(w http.ResponseWriter, r *http.Request, d *db.DB) {
	var rq struct{ Token, Fingerprint, Name string }
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&rq) != nil || rq.Token == "" ||
		!fingerprintRe.MatchString(rq.Fingerprint) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	out := Enrolled{Credential: newSecret(32)} // 256 bit
	// Claim and row in one transaction: an enrollment that fails after the claim keeps the token.
	err := d.InClaimedTenant(r.Context(),
		`SELECT t::text FROM claim_enrollment_token($1) t WHERE t IS NOT NULL`, hash(rq.Token),
		func(tx pgx.Tx, tenant string) error {
			return tx.QueryRow(r.Context(), `INSERT INTO gateways ("Id", "TenantId", "Name", "DtlsFingerprint", "CredentialHash")
				VALUES (uuidv7(), $1, $2, $3, $4) RETURNING "Id"::text`,
				tenant, name(rq.Name), rq.Fingerprint, hash(out.Credential)).
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
