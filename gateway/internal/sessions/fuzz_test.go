package sessions

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"

	"streamiq/gateway/internal/identity"
	"streamiq/gateway/internal/pairing"
)

// Fixed identities, so a signature in a seed or a committed finding stays valid.
const (
	fuzzGatewayFp = "gateway-fp"
	fuzzPeerFp    = "browser-fp"
	fuzzChallenge = "challenge"
	fuzzNonce     = "nb"
)

var fuzzKey = func() *ecdsa.PrivateKey {
	d := sha256.Sum256([]byte("streamiq fuzz client key"))
	k, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), d[:])
	if err != nil {
		panic(err)
	}
	return k
}()

func fuzzAuth(pair bool) string {
	h := sha256.Sum256(pairing.AuthMessage(fuzzGatewayFp, fuzzPeerFp, fuzzChallenge))
	r, s, _ := ecdsa.Sign(rand.Reader, fuzzKey, h[:])
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	b, _ := json.Marshal(Auth{Type: "auth", Spki: spki(fuzzKey), Sig: sig, Pair: pair})
	return string(b)
}

func sha256Hex(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

// FuzzAuthHandshake feeds the `auth` handshake any sequence of messages (one per
// line), from a key that is paired or not, with the owner approving or rejecting
// whatever reaches the local page. The gateway never says `ok` without a valid
// signature from the paired key, nor `approved` without a valid signature, a
// reveal that matches a commit, and the owner's approval.
func FuzzAuthHandshake(f *testing.F) {
	commit := `{"type":"commit","h":"` + sha256Hex(fuzzNonce) + `","name":"x"}`
	reveal := `{"type":"reveal","n":"` + fuzzNonce + `"}`
	for _, c := range []struct {
		msgs            []string
		paired, approve bool
	}{
		{[]string{fuzzAuth(false)}, true, false},
		{[]string{fuzzAuth(true)}, true, false},
		{[]string{fuzzAuth(false), commit, reveal}, false, true},
		{[]string{fuzzAuth(true), commit, reveal}, true, false},
		{[]string{fuzzAuth(false), commit, `{"type":"reveal","n":"other"}`}, false, true},
		{[]string{fuzzAuth(false), commit, reveal, reveal}, false, true},
		{[]string{fuzzAuth(false), commit, commit}, false, true},
		{[]string{fuzzAuth(false), fuzzAuth(false)}, true, true},
		{[]string{commit}, false, true},
		{[]string{reveal}, false, true},
		{[]string{`{"type":"ok"}`, `{"type":"approved"}`}, true, true},
		{[]string{`{"type":"auth","spki":"AAAA","sig":"AAAA"}`}, true, true},
		{[]string{"not json"}, true, true},
	} {
		f.Add([]byte(strings.Join(c.msgs, "\n")), c.paired, c.approve)
	}
	orig := log.Writer()
	log.SetOutput(io.Discard)
	f.Cleanup(func() { log.SetOutput(orig) })
	f.Fuzz(func(t *testing.T, in []byte, paired, approve bool) {
		msgs := bytes.Split(in, []byte("\n"))
		sent := runHandshake(t, msgs, paired, approve)
		checkHandshake(t, msgs, sent, paired, approve)
	})
}

// runHandshake runs msgs through one handshake and returns the types the gateway sent.
func runHandshake(t *testing.T, msgs [][]byte, paired, approve bool) []string {
	dir := t.TempDir()
	if paired {
		b, _ := json.Marshal([]pairing.Paired{{KeyFp: identity.Fingerprint(spki(fuzzKey)), Name: "x"}})
		if err := os.WriteFile(filepath.Join(dir, "allowlist.json"), b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	store, err := pairing.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var sent []string
	synctest.Test(t, func(t *testing.T) {
		s := &Sessions{Fp: fuzzGatewayFp, Store: store, keys: map[string]string{},
			ends: map[string]func(bool){"s": func(bool) {}}}
		a := &authRun{s: s, id: "s", user: "u", pre: s.admit(), authed: new(atomic.Bool), why: new(atomic.Value),
			challenge: fuzzChallenge, done: make(chan struct{}),
			send: func(m string) error {
				var head struct{ Type string }
				_ = json.Unmarshal([]byte(m), &head)
				mu.Lock()
				defer mu.Unlock()
				sent = append(sent, head.Type)
				return nil
			},
			hangUp: func() error { return nil },
			peerFp: func() string { return fuzzPeerFp },
		}
		for _, m := range msgs {
			a.handle(m)
		}
		synctest.Wait()
		if p := store.Pending(); len(p) > 0 { // the owner on the local page
			if err := store.Decide(p[0].ID, approve); err != nil {
				t.Fatal(err)
			}
			synctest.Wait()
		}
		a.end()
	})
	return sent
}

// checkHandshake is the oracle: what msgs allow the gateway to have sent.
func checkHandshake(t *testing.T, msgs [][]byte, sent []string, paired, approve bool) {
	var signed, signedPaired bool
	commits := map[string]bool{}
	var reveals []string
	for _, m := range msgs {
		var head struct{ Type string }
		if json.Unmarshal(m, &head) != nil {
			continue
		}
		switch head.Type {
		case "auth":
			var x Auth
			if json.Unmarshal(m, &x) != nil {
				continue
			}
			fp, err := pairing.VerifyAuth(x.Spki, x.Sig, fuzzGatewayFp, fuzzPeerFp, fuzzChallenge)
			signed = signed || err == nil
			signedPaired = signedPaired || err == nil && !x.Pair && fp == identity.Fingerprint(spki(fuzzKey))
		case "commit":
			var x Commit
			if json.Unmarshal(m, &x) == nil {
				commits[x.H] = true
			}
		case "reveal":
			var x Reveal
			if json.Unmarshal(m, &x) == nil {
				reveals = append(reveals, x.N)
			}
		}
	}
	matched := false
	for _, n := range reveals {
		matched = matched || commits[sha256Hex(n)]
	}
	var ok, approved int
	for _, typ := range sent {
		switch typ {
		case "ok":
			ok++
		case "approved":
			approved++
		}
	}
	okAllowed := paired && signedPaired
	approvedAllowed := approve && signed && matched
	if ok > 0 && !okAllowed {
		t.Errorf("ok without a valid signature from the paired key; sent %v", sent)
	}
	if approved > 0 && !approvedAllowed {
		t.Errorf("approved without signature (%v), matching reveal (%v) and approval (%v); sent %v",
			signed, matched, approve, sent)
	}
	if ok+approved > 1 {
		t.Errorf("authorized more than once: sent %v", sent)
	}
}
