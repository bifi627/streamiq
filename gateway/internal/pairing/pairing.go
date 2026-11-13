// Package pairing is the gateway side of flow 2 (design: specs/2026-11-01-streamiq-
// agent-pairing-design.md): verify a browser's session-bound client-key
// signature, compute the commit/reveal comparison code, and keep the allowlist
// of paired browsers plus the pending requests the local page approves.
// Shared primitive: used by the sessions slice and the local page.
package pairing

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"streamiq/gateway/internal/identity"
)

const (
	PendingFor = 5 * time.Minute
	MaxPending = 3
)

// AuthMessage is what the browser signs (docs/protocol.md, "Connection auth"):
// both DTLS fingerprints of *this* session, so a MITM terminating two separate
// DTLS sessions can't relay a valid signature.
func AuthMessage(gatewayFp, browserDtlsFp, challenge string) []byte {
	return []byte("streamiq-auth-v1|" + gatewayFp + "|" + browserDtlsFp + "|" + challenge)
}

// VerifyAuth checks sig (WebCrypto's raw 64-byte r‖s, not ASN.1) over
// AuthMessage with the P-256 key in spki, and returns the key's fingerprint.
func VerifyAuth(spki, sig []byte, gatewayFp, browserDtlsFp, challenge string) (string, error) {
	pub, err := x509.ParsePKIXPublicKey(spki)
	if err != nil {
		return "", fmt.Errorf("spki: %w", err)
	}
	k, ok := pub.(*ecdsa.PublicKey)
	if !ok || k.Curve.Params().Name != "P-256" || len(sig) != 64 {
		return "", errors.New("want a P-256 key and a 64-byte signature")
	}
	h := sha256.Sum256(AuthMessage(gatewayFp, browserDtlsFp, challenge))
	r, s := new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])
	if !ecdsa.Verify(k, h[:], r, s) {
		return "", errors.New("bad signature")
	}
	return identity.Fingerprint(spki), nil
}

// Code is the 6-digit comparison code (docs/protocol.md). The nonces are
// committed before they're revealed, so a MITM gets one guess, not a grind.
func Code(gatewayFp, keyFp, nA, nB string) string {
	h := sha256.Sum256([]byte(gatewayFp + "|" + keyFp + "|" + nA + "|" + nB))
	return fmt.Sprintf("%06d", binary.BigEndian.Uint32(h[:4])%1_000_000)
}

// Nonce is 32 random bytes, hex.
func Nonce() string {
	b := make([]byte, 32)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// Paired is one allowlist entry (allowlist.json in the state dir).
type Paired struct {
	KeyFp   string    `json:"keyFp"`
	Name    string    `json:"name"`
	AddedAt time.Time `json:"addedAt"`
}

// Request is a pairing request waiting for Approve on the local page.
type Request struct {
	ID, Name, KeyFp, Code string
	Expires               time.Time
	decide                chan bool
}

// Store holds the allowlist (persisted) and pending requests (memory only: an
// gateway restart drops them, the browser just asks again).
type Store struct {
	path string
	mu   sync.Mutex
	// OnRemove runs after Remove (outside the lock): the sessions slice closes
	// that key's open sessions. Set once at startup.
	OnRemove func(keyFp string)
	paired   []Paired
	pending  []*Request
	reserved int // slots taken by Reserve, at most MaxPending
}

func Open(dir string) (*Store, error) {
	s := &Store{path: filepath.Join(dir, "allowlist.json")}
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	return s, json.Unmarshal(b, &s.paired)
}

func (s *Store) Allowed(keyFp string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.ContainsFunc(s.paired, func(p Paired) bool { return p.KeyFp == keyFp })
}

func (s *Store) Paired() []Paired {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.paired)
}

func (s *Store) Pending() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Request, len(s.pending))
	for i, r := range s.pending {
		out[i] = *r
	}
	return out
}

// Remove drops a paired browser and ends its open sessions (OnRemove) — even
// if saving fails, since the in-memory allowlist already refuses it.
func (s *Store) Remove(keyFp string) error {
	s.mu.Lock()
	s.paired = slices.DeleteFunc(s.paired, func(p Paired) bool { return p.KeyFp == keyFp })
	err := s.save()
	s.mu.Unlock()
	if s.OnRemove != nil {
		s.OnRemove(keyFp)
	}
	return err
}

// Reserve takes one of the MaxPending pairing slots. A pairing exchange holds
// its slot from the accepted `commit` until it ends, whatever the outcome, and
// then gives it back with Release.
func (s *Store) Reserve() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.reserved >= MaxPending {
		return errors.New("too many pending pairing requests")
	}
	s.reserved++
	return nil
}

// Release gives back a slot taken with Reserve.
func (s *Store) Release() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reserved--
}

// Ask queues a request and blocks until the local page decides, it expires, or
// gone closes (the asking connection ended). Approve persists the key before
// returning true. The caller holds a slot from Reserve: that is the cap.
func (s *Store) Ask(name, keyFp, code string, gone <-chan struct{}) (bool, error) {
	r := &Request{ID: Nonce()[:16], Name: name, KeyFp: keyFp, Code: code,
		Expires: time.Now().Add(PendingFor), decide: make(chan bool, 1)}
	s.mu.Lock()
	s.pending = append(s.pending, r)
	s.mu.Unlock()
	defer s.drop(r)

	select {
	case ok := <-r.decide:
		return ok, nil
	case <-gone:
		return false, errors.New("connection closed")
	case <-time.After(PendingFor):
		return false, nil
	}
}

// Decide is the local page's Approve/Reject.
func (s *Store) Decide(id string, approve bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := slices.IndexFunc(s.pending, func(r *Request) bool { return r.ID == id })
	if i < 0 {
		return errors.New("no such request (expired?)")
	}
	r := s.pending[i]
	if approve && !slices.ContainsFunc(s.paired, func(p Paired) bool { return p.KeyFp == r.KeyFp }) {
		s.paired = append(s.paired, Paired{KeyFp: r.KeyFp, Name: r.Name, AddedAt: time.Now().UTC()})
		if err := s.save(); err != nil {
			return err
		}
	}
	s.pending = slices.Delete(s.pending, i, i+1)
	r.decide <- approve
	return nil
}

func (s *Store) drop(r *Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pending = slices.DeleteFunc(s.pending, func(p *Request) bool { return p == r })
}

func (s *Store) save() error { // caller holds mu
	b, _ := json.MarshalIndent(s.paired, "", " ")
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(s.path, b, 0o600)
}
