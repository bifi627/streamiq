package auth

import (
	"crypto/sha256"
	"encoding/hex"
)

// HashSecret is how a gateway credential, enrollment token or invite token is stored and looked up:
// SHA-256 hex, never the plaintext.
func HashSecret(secret string) string {
	h := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(h[:])
}
