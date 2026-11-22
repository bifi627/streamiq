// The `auth` data channel: the client-key proof and the pairing exchange (docs/protocol.md, "Pairing").

package sessions

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"

	"streamiq/gateway/internal/identity"
	"streamiq/gateway/internal/pairing"
)

// serveAuth runs challenge → auth → (ok | unpaired → commit → nonce → reveal →
// approved/rejected), once per connection (newPeer). Messages on one channel
// arrive in order, one at a time; after a refusal none is handled.
func (s *Sessions) serveAuth(
	id, user string,
	pc *webrtc.PeerConnection,
	d *webrtc.DataChannel,
	authed *atomic.Bool,
	why *atomic.Value,
) {
	a := &authRun{s: s, id: id, user: user, pc: pc, d: d, authed: authed, why: why,
		challenge: pairing.Nonce(), done: make(chan struct{})}
	d.OnOpen(func() { a.say(Challenge{Type: "challenge", N: a.challenge}) })
	d.OnClose(a.end)
	d.OnMessage(a.handle)
}

// authState is where an `auth` handshake stands.
type authState struct {
	keyed     bool // an auth passed: the client key is known
	committed bool // the one commit was accepted
	revealed  bool // the one reveal arrived
	authed    bool // ok or approved
}

// accepts: which message the handshake takes next; anything else is `unexpected <type>`.
func (st authState) accepts(typ string) bool {
	switch typ {
	case "auth":
		return !st.keyed
	case "commit":
		return st.keyed && !st.authed && !st.committed
	case "reveal":
		return st.committed && !st.revealed
	}
	return false
}

// authRun is one connection's `auth` handshake (serveAuth).
type authRun struct {
	s         *Sessions
	id, user  string
	pc        *webrtc.PeerConnection
	d         *webrtc.DataChannel
	authed    *atomic.Bool
	why       *atomic.Value
	challenge string
	done      chan struct{} // closed when the channel closes or we refuse
	once      sync.Once
	keyFp     string
	reveal    chan string // non-nil once the one commit is accepted
	revealed  bool
}

// say: a failed send means the channel closed, and its OnClose ends the handshake.
func (a *authRun) say(m any) { b, _ := json.Marshal(m); _ = a.d.SendText(string(b)) }

func (a *authRun) end() { a.once.Do(func() { close(a.done) }) }

func (a *authRun) fail(reason string) {
	log.Printf("gateway: auth: %s", reason)
	a.why.Store(reason)
	a.say(Rejected{Type: "rejected", Reason: reason})
	a.d.Close()
	a.end()
}

func (a *authRun) handle(raw webrtc.DataChannelMessage) {
	select {
	case <-a.done:
		return
	default:
	}
	var head struct{ Type string }
	if json.Unmarshal(raw.Data, &head) != nil {
		a.fail("bad message")
		return
	}
	var m any // the message's own type, if a client may send it
	switch head.Type {
	case "auth":
		m = &Auth{}
	case "commit":
		m = &Commit{}
	case "reveal":
		m = &Reveal{}
	}
	if m != nil && json.Unmarshal(raw.Data, m) != nil {
		a.fail("bad message")
		return
	}
	st := authState{keyed: a.keyFp != "", committed: a.reveal != nil, revealed: a.revealed, authed: a.authed.Load()}
	if !st.accepts(head.Type) {
		a.fail("unexpected " + head.Type)
		return
	}
	switch m := m.(type) {
	case *Auth:
		a.auth(*m)
	case *Commit:
		a.commit(*m)
	case *Reveal:
		a.revealed = true // one reveal per channel
		a.reveal <- m.N
	}
}

func (a *authRun) auth(m Auth) {
	// The browser's DTLS cert as actually negotiated on this connection.
	browserFp := identity.Fingerprint(a.pc.SCTP().Transport().GetRemoteCertificate())
	fp, err := pairing.VerifyAuth(m.Spki, m.Sig, a.s.Fp, browserFp, a.challenge)
	if err != nil {
		a.fail(err.Error())
		return
	}
	a.keyFp = fp
	// Record first, then check: a concurrent Remove either sees this
	// session in Drop or has already taken the key off the allowlist.
	if !a.s.record(a.id, fp) {
		return // ended meanwhile: no key to leak, no viewer to make
	}
	if a.s.Store.Allowed(fp) && !m.Pair {
		a.s.authorize(a.user, a.authed)
		a.say(OK{Type: "ok"})
	} else {
		a.why.Store("unpaired")
		a.say(Unpaired{Type: "unpaired"})
	}
}

func (a *authRun) commit(m Commit) {
	// The slot is taken before the nonce goes out, so the nonces handed
	// out are capped like the requests on the local page.
	if err := a.s.Store.Reserve(); err != nil {
		a.fail(err.Error())
		return
	}
	a.reveal = make(chan string, 1)
	nA := pairing.Nonce() // only now: the browser is committed to nB
	go a.s.pair(a.id, a.keyFp, m.H, trim(m.Name), nA, a.reveal, a.done, a.fail, func() {
		a.s.authorize(a.user, a.authed)
		a.say(Approved{Type: "approved"})
	})
	a.say(Nonce{Type: "nonce", N: nA})
}

// pair is the exchange after an accepted commit. It owns the pairing slot and
// gives it back however the exchange ends.
func (s *Sessions) pair(
	id, keyFp, commit, name, nA string,
	reveal <-chan string,
	done <-chan struct{},
	fail func(string),
	approved func(),
) {
	defer s.Store.Release()
	var nB string
	select {
	case nB = <-reveal:
	case <-done:
		log.Printf("gateway: session %s: pairing abandoned after commit", id)
		return
	case <-time.After(pairing.PendingFor):
		fail("no reveal")
		return
	}
	if h := sha256.Sum256([]byte(nB)); hex.EncodeToString(h[:]) != commit {
		fail("reveal does not match commit")
		return
	}
	ok, err := s.Store.Ask(name, keyFp, pairing.Code(s.Fp, keyFp, nA, nB), done)
	switch {
	case err != nil:
		fail(err.Error())
	case !ok:
		fail("not approved")
	default:
		approved()
	}
}
