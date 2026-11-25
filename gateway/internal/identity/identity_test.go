package identity

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// A pin is only useful if the gateway has the same key after a restart.
func TestKeyStableAcrossReload(t *testing.T) {
	dir := t.TempDir()
	k1, fp1, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatal(err)
	}
	k2, fp2, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatal(err)
	}
	if fp1 != fp2 || !k1.Equal(k2) {
		t.Fatalf("fingerprint changed across reload: %s vs %s", fp1, fp2)
	}
	if !regexp.MustCompile(`^sha-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}$`).MatchString(fp1) {
		t.Fatalf("fingerprint %q not in contract form", fp1)
	}
}

// The pre-#427 DTLS certificate goes when the key is made: nothing reads it.
func TestLegacyCertRemoved(t *testing.T) {
	dir := t.TempDir()
	cert := filepath.Join(dir, legacyCert)
	if err := os.WriteFile(cert, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := LoadOrCreate(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(cert); !os.IsNotExist(err) {
		t.Fatalf("cert.pem survived: %v", err)
	}
}

func TestResetNewIdentityEmptyAllowlist(t *testing.T) {
	dir := t.TempDir()
	_, fp1, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatal(err)
	}
	allow := filepath.Join(dir, "allowlist.json")
	if err = os.WriteFile(allow, []byte(`[{"keyFp":"x"}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	fp2, err := Reset(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, fp3, _ := LoadOrCreate(dir); fp2 == fp1 || fp3 != fp2 {
		t.Fatalf("fingerprints old %s, reset %s, reloaded %s", fp1, fp2, fp3)
	}
	if _, err := os.Stat(allow); !os.IsNotExist(err) {
		t.Fatalf("allowlist.json survived reset: %v", err)
	}
}
