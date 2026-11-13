package pairing

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

// Shared vectors (docs/protocol.md): produced by WebCrypto, so this catches the
// P1363-vs-ASN.1 signature mismatch. The TS tests assert the same values.
const (
	vecSpki      = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEmTtuIwyQLY7DzMMjTIsUkxazWggTTnJfvoyqtVJQzLXYaz58fk1XDvkQ8y5xMBXImlv4R1tOqSQnvfXeMJHHNw=="
	vecKeyFp     = "sha-256 40:F0:B4:7F:13:E4:C0:9B:73:86:7F:7A:77:E1:16:71:A2:AF:84:61:A0:8F:9F:15:25:CB:FE:7F:82:8A:C6:10"
	vecGatewayFp = "sha-256 D4:F0:BC:5A:29:DE:06:B5:10:F9:AA:42:8F:1E:ED:BA:92:60:12:B5:91:FE:F7:A5:18:E7:76:A7:C9:BD:18:24"
	vecBrowser   = "sha-256 D4:C3:E8:A1:12:56:AB:82:A4:FC:72:56:0E:B4:A2:B0:E8:7B:AD:82:0C:29:0D:D9:B0:36:16:DE:24:0A:A6:DB"
	vecN         = "0000000000000000000000000000000000000000000000000000000000000001"
	vecSig       = "jXq2DxskrRUJ2/lPhsID2biFys0vK47f+Z9XNWopW2mdfxatIsNm8/UtQV6feHlf/U42r5ERviRotv6W8GE0GQ=="
)

func b64(s string) []byte { b, _ := base64.StdEncoding.DecodeString(s); return b }

func TestVerifyAuthVector(t *testing.T) {
	fp, err := VerifyAuth(b64(vecSpki), b64(vecSig), vecGatewayFp, vecBrowser, vecN)
	if err != nil || fp != vecKeyFp {
		t.Fatalf("VerifyAuth = %q, %v", fp, err)
	}
	// Bound to this session: another browser DTLS fp (a MITM's) must fail.
	if _, err := VerifyAuth(b64(vecSpki), b64(vecSig), vecGatewayFp, vecGatewayFp, vecN); err == nil {
		t.Fatal("signature verified for a different session")
	}
}

func TestCodeVector(t *testing.T) {
	if c := Code(vecGatewayFp, vecKeyFp, strings.Repeat("11", 32), strings.Repeat("22", 32)); c != "138781" {
		t.Fatalf("code = %s, want 138781", c)
	}
}

func TestApprovePersistsAndPendingCaps(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	got := make(chan bool)
	go func() { ok, _ := s.Ask("phone", "fp-1", "123456", nil); got <- ok }()
	for len(s.Pending()) == 0 {
		time.Sleep(time.Millisecond)
	}
	if err := s.Decide(s.Pending()[0].ID, true); err != nil || !<-got {
		t.Fatalf("approve failed: %v", err)
	}
	if s2, _ := Open(dir); !s2.Allowed("fp-1") {
		t.Fatal("approval not persisted")
	}

	for range MaxPending {
		if err := s.Reserve(); err != nil {
			t.Fatal(err)
		}
	}
	if s.Reserve() == nil {
		t.Fatal("want an error past MaxPending")
	}
	s.Release()
	if err := s.Reserve(); err != nil {
		t.Fatalf("a released slot must be free again: %v", err)
	}
}

// A request whose connection ended leaves the local page at once.
func TestAskEndsWhenConnectionCloses(t *testing.T) {
	s, _ := Open(t.TempDir())
	gone := make(chan struct{})
	close(gone)
	if ok, err := s.Ask("phone", "fp-1", "123456", gone); ok || err == nil || len(s.Pending()) != 0 {
		t.Fatalf("Ask = %v, %v with %d pending", ok, err, len(s.Pending()))
	}
}

// Remove on the gateway page: the key is no longer allowed, also after a restart.
func TestRemovePersists(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	go s.Ask("phone", "fp-1", "123456", nil)
	for len(s.Pending()) == 0 {
		time.Sleep(time.Millisecond)
	}
	s.Decide(s.Pending()[0].ID, true)
	if err := s.Remove("fp-1"); err != nil || s.Allowed("fp-1") {
		t.Fatalf("still allowed after Remove (err %v)", err)
	}
	if s2, _ := Open(dir); s2.Allowed("fp-1") {
		t.Fatal("Remove not persisted")
	}
}
