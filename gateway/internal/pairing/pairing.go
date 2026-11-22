// Package pairing is the gateway side of pairing: verify a browser's session-bound client-key
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
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf16"

	"streamiq/gateway/internal/identity"
)

const (
	PendingFor = 5 * time.Minute
	MaxPending = 3
	// MaxPendingPerUser: one account can't hold every slot; the rest stay free for the household.
	MaxPendingPerUser = 1
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
// Its JSON format changed? Update oldState in cmd/gateway/update_windows_test.go
// in the same PR: the update test starts from it.
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
	reserved map[string]int // user → slots taken by Reserve; at most MaxPending in all, MaxPendingPerUser each
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

// ErrBadName: a name must be 1–100 characters after trimming, counted in UTF-16
// units like the API (an emoji counts 2), with no control characters. Gateway
// and client names share the rule.
var ErrBadName = errors.New("name must be 1-100 characters, no control characters")

// ErrNotPaired: Rename of a key that isn't on the allowlist.
var ErrNotPaired = errors.New("not paired")

// CleanName trims name and checks it against ErrBadName's rule.
func CleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if n := len(utf16.Encode([]rune(name))); n < 1 || n > 100 || strings.ContainsFunc(name, unicode.IsControl) {
		return "", ErrBadName
	}
	return name, nil
}

// Rename gives a paired client a new name and saves the allowlist; a
// failed save keeps the old name. An open screen keeps the name it opened with.
func (s *Store) Rename(keyFp, name string) (string, error) {
	name, err := CleanName(name)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	i := slices.IndexFunc(s.paired, func(p Paired) bool { return p.KeyFp == keyFp })
	if i < 0 {
		return "", ErrNotPaired
	}
	old := s.paired[i].Name
	s.paired[i].Name = name
	if err := s.save(); err != nil {
		s.paired[i].Name = old
		return "", err
	}
	return name, nil
}

// Reserve takes one of the MaxPending pairing slots for user. A pairing exchange
// holds its slot from the accepted `commit` until it ends, whatever the outcome,
// and then gives it back with Release.
func (s *Store) Reserve(user string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	total := 0
	for _, n := range s.reserved {
		total += n
	}
	switch {
	case total >= MaxPending:
		return errors.New("too many pending pairing requests")
	case s.reserved[user] >= MaxPendingPerUser:
		return errors.New("this user is already pairing a browser")
	}
	if s.reserved == nil {
		s.reserved = map[string]int{}
	}
	s.reserved[user]++
	return nil
}

// Release gives back a slot taken with Reserve(user).
func (s *Store) Release(user string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.reserved[user]--; s.reserved[user] <= 0 {
		delete(s.reserved, user)
	}
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
