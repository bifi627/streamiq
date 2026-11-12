package identity

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// A pin is only useful if the gateway presents the same cert after a restart.
func TestCertStableAcrossReload(t *testing.T) {
	dir := t.TempDir()
	c1, fp1, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatal(err)
	}
	c2, fp2, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatal(err)
	}
	if fp1 != fp2 || !c1.Equals(*c2) {
		t.Fatalf("fingerprint changed across reload: %s vs %s", fp1, fp2)
	}
	if !regexp.MustCompile(`^sha-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}$`).MatchString(fp1) {
		t.Fatalf("fingerprint %q not in contract form", fp1)
	}
}

// No expiry cliff: Pion refuses an expired local cert, so ours lasts until 9999
// and Pion must accept that date.
func TestCertNeverExpires(t *testing.T) {
	c, _, err := LoadOrCreate(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC); !c.Expires().Equal(want) {
		t.Fatalf("cert expires %s, want %s", c.Expires(), want)
	}
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{Certificates: []webrtc.Certificate{*c}})
	if err != nil {
		t.Fatalf("Pion rejects the cert: %v", err)
	}
	pc.Close()
}

func TestResetNewIdentityEmptyAllowlist(t *testing.T) {
	dir := t.TempDir()
	_, fp1, err := LoadOrCreate(dir)
	if err != nil {
		t.Fatal(err)
	}
	allow := filepath.Join(dir, "allowlist.json")
	if err := os.WriteFile(allow, []byte(`[{"keyFp":"x"}]`), 0o600); err != nil {
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
