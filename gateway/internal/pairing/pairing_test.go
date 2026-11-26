package pairing

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"strings"
	"testing"
	"testing/synctest"
)

// Shared vectors (docs/protocol.md), testdata/vectors.json, which the TS tests read too:
// sig is WebCrypto's, so this catches the P1363-vs-ASN.1 signature mismatch; proof is
// Prove's with the same key as the gateway's identity key, over the same session.
var vec = func() (v struct {
	Pkcs8, Spki, KeyFp, GatewayFp, BrowserFp, N, Sig, Proof, CodeNA, CodeNB, Code string
}) {
	b, err := os.ReadFile("testdata/vectors.json")
	if err == nil {
		err = json.Unmarshal(b, &v)
	}
	if err != nil {
		panic(err)
	}
	return v
}()

func b64(s string) []byte { b, _ := base64.StdEncoding.DecodeString(s); return b }

func TestVerifyAuthVector(t *testing.T) {
	fp, err := VerifyAuth(b64(vec.Spki), b64(vec.Sig), vec.GatewayFp, vec.BrowserFp, vec.N)
	if err != nil || fp != vec.KeyFp {
		t.Fatalf("VerifyAuth = %q, %v", fp, err)
	}
	// Bound to this session: another browser DTLS fp (a MITM's) must fail.
	if _, err := VerifyAuth(b64(vec.Spki), b64(vec.Sig), vec.GatewayFp, vec.GatewayFp, vec.N); err == nil {
		t.Fatal("signature verified for a different session")
	}
}

// Only a P-256 key with a 64-byte (P1363) signature gets its signature checked;
// any other key or length is refused up front.
func TestVerifyAuthRefusesOtherKeys(t *testing.T) {
	p384, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	ed, _, _ := ed25519.GenerateKey(rand.Reader)
	der := func(k any) []byte { b, _ := x509.MarshalPKIXPublicKey(k); return b }
	sig := b64(vec.Sig)
	for name, c := range map[string]struct{ spki, sig []byte }{
		"P-384 key":       {der(&p384.PublicKey), sig},
		"Ed25519 key":     {der(ed), sig},
		"short signature": {b64(vec.Spki), sig[:63]},
		"long signature":  {b64(vec.Spki), append(sig[:64:64], 0)},
		"no signature":    {b64(vec.Spki), nil},
	} {
		if _, err := VerifyAuth(
			c.spki,
			c.sig,
			vec.GatewayFp,
			vec.BrowserFp,
			vec.N,
		); err == nil ||
			!strings.Contains(err.Error(), "P-256") {
			t.Errorf("%s: err = %v, want refused before the signature check", name, err)
		}
	}
}

// verifyProof is the browser's check of the challenge (crypto.ts verifyProof).
func verifyProof(spki, sig []byte, gatewayDtlsFp, browserDtlsFp, n string) bool {
	pub, err := x509.ParsePKIXPublicKey(spki)
	k, ok := pub.(*ecdsa.PublicKey)
	if err != nil || !ok || len(sig) != 64 {
		return false
	}
	h := sha256.Sum256(GatewayMessage(gatewayDtlsFp, browserDtlsFp, n))
	return ecdsa.Verify(k, h[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:]))
}

func TestProve(t *testing.T) {
	if !verifyProof(b64(vec.Spki), b64(vec.Proof), vec.GatewayFp, vec.BrowserFp, vec.N) {
		t.Fatal("proof vector doesn't verify")
	}
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	spki, sig, err := Prove(k, vec.GatewayFp, vec.BrowserFp, vec.N)
	if err != nil || !verifyProof(spki, sig, vec.GatewayFp, vec.BrowserFp, vec.N) {
		t.Fatalf("fresh proof doesn't verify: %v", err)
	}
	// Bound to this tunnel: a MITM's DTLS fp on either side, or the client's message, fails.
	if verifyProof(spki, sig, vec.GatewayFp, vec.GatewayFp, vec.N) ||
		verifyProof(spki, sig, vec.BrowserFp, vec.BrowserFp, vec.N) {
		t.Fatal("proof verified for a different tunnel")
	}
	if verifyProof(b64(vec.Spki), b64(vec.Sig), vec.GatewayFp, vec.BrowserFp, vec.N) {
		t.Fatal("the client's auth signature passes as the gateway's proof")
	}
}

func TestCodeVector(t *testing.T) {
	if c := Code(vec.GatewayFp, vec.KeyFp, vec.CodeNA, vec.CodeNB); c != vec.Code {
		t.Fatalf("code = %s, want %s", c, vec.Code)
	}
}

func TestApprovePersistsAndPendingCaps(t *testing.T) {
	dir := t.TempDir() // outside the bubble: its cleanup retries on real time (Windows)
	synctest.Test(t, func(t *testing.T) {
		s, _ := Open(dir)
		got := make(chan bool)
		go func() { ok, _ := s.Ask("phone", "fp-1", "123456", "u1", nil); got <- ok }()
		synctest.Wait() // Ask now waits for Decide
		if err := s.Decide(s.Pending()[0].ID, true); err != nil || !<-got {
			t.Fatalf("approve failed: %v", err)
		}
		if s2, _ := Open(dir); !s2.Allowed("fp-1") || s2.Paired()[0].ApprovedBy != "" {
			t.Fatal("approval not persisted, or a local page approval names an approver")
		}

		for i := range MaxPending {
			if err := s.Reserve(fmt.Sprint("u", i)); err != nil {
				t.Fatal(err)
			}
		}
		if s.Reserve("u-new") == nil {
			t.Fatal("want an error past MaxPending")
		}
		s.Release("u0")
		if err := s.Reserve("u-new"); err != nil {
			t.Fatalf("a released slot must be free again: %v", err)
		}
	})
}

// One user holds at most MaxPendingPerUser slots; the others stay free for the household.
func TestReservePerUser(t *testing.T) {
	s, _ := Open(t.TempDir())
	for range MaxPendingPerUser {
		if err := s.Reserve("a"); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Reserve("a"); err == nil || !strings.Contains(err.Error(), "already pairing") {
		t.Fatalf("one over MaxPendingPerUser = %v, want refused", err)
	}
	if err := s.Reserve("b"); err != nil {
		t.Fatalf("another user must still get a slot: %v", err)
	}
	s.Release("a")
	if err := s.Reserve("a"); err != nil {
		t.Fatalf("a released slot must be free again: %v", err)
	}
}

// A request whose connection ended leaves the local page at once.
func TestAskEndsWhenConnectionCloses(t *testing.T) {
	s, _ := Open(t.TempDir())
	gone := make(chan struct{})
	close(gone)
	if ok, err := s.Ask("phone", "fp-1", "123456", "u1", gone); ok || err == nil || len(s.Pending()) != 0 {
		t.Fatalf("Ask = %v, %v with %d pending", ok, err, len(s.Pending()))
	}
}

// Remove on the gateway page: the key is no longer allowed, also after a restart.
func TestRemovePersists(t *testing.T) {
	dir := t.TempDir() // outside the bubble: its cleanup retries on real time (Windows)
	synctest.Test(t, func(t *testing.T) {
		s, _ := Open(dir)
		go func() { _, _ = s.Ask("phone", "fp-1", "123456", "u1", nil) }() // the Decide below answers it
		synctest.Wait()
		if err := s.Decide(s.Pending()[0].ID, true); err != nil {
			t.Fatal(err)
		}
		if err := s.Remove("fp-1"); err != nil || s.Allowed("fp-1") {
			t.Fatalf("still allowed after Remove (err %v)", err)
		}
		if s2, _ := Open(dir); s2.Allowed("fp-1") {
			t.Fatal("Remove not persisted")
		}
	})
}

// A name is 1–100 UTF-16 units after trimming (#520): exactly 100 is fine, an emoji counts 2.
func TestCleanNameLength(t *testing.T) {
	for name, ok := range map[string]bool{
		strings.Repeat("a", 100):       true,
		strings.Repeat("a", 101):       false,
		strings.Repeat("😀", 50):        true,
		strings.Repeat("😀", 50) + "a":  false,
		" " + strings.Repeat("a", 100): true,
		"":                             false,
	} {
		if _, err := CleanName(name); (err == nil) != ok {
			t.Errorf("CleanName(%d bytes): err %v, want ok=%v", len(name), err, ok)
		}
	}
}

// Decide (#520): a reject pairs nothing, and approving a key that is already
// paired (a second pairing, e.g. after a pin mismatch) adds no second entry.
func TestDecideAllowlist(t *testing.T) {
	dir := t.TempDir()
	synctest.Test(t, func(t *testing.T) {
		s, _ := Open(dir)
		decide := func(fp string, approve bool) {
			t.Helper()
			done := make(chan struct{})
			go func() { _, _ = s.Ask("phone", fp, "123456", "u1", nil); close(done) }() // the Decide below answers it
			synctest.Wait()
			if err := s.Decide(s.Pending()[0].ID, approve); err != nil {
				t.Fatal(err)
			}
			<-done
		}
		decide("fp-1", false)
		if s.Allowed("fp-1") || len(s.Paired()) != 0 {
			t.Fatalf("rejected key paired: %v", s.Paired())
		}
		decide("fp-1", true)
		decide("fp-1", true)
		if len(s.Paired()) != 1 {
			t.Fatalf("key approved twice: %v", s.Paired())
		}
	})
}
