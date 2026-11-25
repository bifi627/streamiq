// Package identity is the gateway's long-term identity: one persistent ECDSA
// P-256 key whose Fingerprint browsers pin. Tunnels use a fresh DTLS
// certificate each (Pion's default), so the key never shows on the wire in the
// clear: the gateway proves it inside the tunnel (pairing.Prove).
package identity

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// File is the identity key in the state dir.
const File = "identity.pem"

// legacyCert is the old persistent DTLS certificate: its pins can't be
// carried over, so it goes.
const legacyCert = "cert.pem"

// LoadOrCreate returns the gateway's identity key and its fingerprint.
// Generated once: a new key breaks every browser's pin. Replacing it is a
// deliberate act: Reset.
func LoadOrCreate(dir string) (*ecdsa.PrivateKey, string, error) {
	path := filepath.Join(dir, File)
	pems, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		pems, err = create(dir, path)
	}
	if err != nil {
		return nil, "", err
	}
	block, _ := pem.Decode(pems)
	if block == nil {
		return nil, "", fmt.Errorf("%s: no PEM block", path)
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	key, ok := k.(*ecdsa.PrivateKey)
	if err != nil || !ok || key.Curve != elliptic.P256() {
		return nil, "", fmt.Errorf("%s: want a P-256 PKCS#8 key (%v)", path, err)
	}
	return key, KeyFingerprint(&key.PublicKey), nil
}

// create writes a new key to path and returns its PEM.
func create(dir, path string) ([]byte, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	pems := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	if err = os.WriteFile(path, pems, 0o600); err != nil {
		return nil, err
	}
	if err = os.Remove(filepath.Join(dir, legacyCert)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return pems, nil
}

// Reset replaces the gateway identity (state dir or a backup of it may have
// leaked): a new key, and an empty allowlist (allowlist.json and its clients'
// profiles.json, see pairing) so every browser pairs again against the new
// fingerprint. The gateway must not be running: it holds both in memory.
func Reset(dir string) (string, error) {
	for _, f := range []string{File, legacyCert, "allowlist.json", "profiles.json"} {
		if err := os.Remove(filepath.Join(dir, f)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	}
	_, fp, err := LoadOrCreate(dir)
	return fp, err
}

// KeyFingerprint is Fingerprint over the key's SPKI bytes.
func KeyFingerprint(k *ecdsa.PublicKey) string {
	spki, _ := x509.MarshalPKIXPublicKey(k) // never fails for a P-256 key
	return Fingerprint(spki)
}

// Fingerprint is the contract form `sha-256 AA:BB:…` (docs/protocol.md).
func Fingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	hex := make([]string, len(sum))
	for i, b := range sum {
		hex[i] = fmt.Sprintf("%02X", b)
	}
	return "sha-256 " + strings.Join(hex, ":")
}
