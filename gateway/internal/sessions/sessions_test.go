package sessions

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"streamiq/gateway/internal/identity"
	"streamiq/gateway/internal/pairing"
	"streamiq/gateway/internal/screen"
	"streamiq/gateway/internal/testwait"
	"streamiq/gateway/internal/tunnel"
)

// A browser (played by a second Pion peer) is refused tunnel channels until it
// pairs; after Approve on the "local page" a tunneled GET goes through, and a
// fresh session with the same key is let straight in.
func TestPairThenTunnel(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/Users" {
			_, _ = w.Write([]byte(`[{"Name":"home","Id":"0123456789abcdef0123456789abcdef"}]`))
			return
		}
		_, _ = w.Write([]byte("jellyfin"))
	}))
	defer origin.Close()
	dir := t.TempDir()
	idKey, fp, err := identity.LoadOrCreate(dir)
	if err != nil {
		t.Fatal(err)
	}
	store, _ := pairing.Open(dir)
	jf := &tunnel.Jellyfin{Client: http.DefaultClient, URL: origin.URL}
	jf.SetKey("k", "0123456789abcdef0123456789abcdef")
	var vmu sync.Mutex
	var viewers []string // users whose viewer was ensured: only once paired (#195)
	gateway := &Sessions{Key: idKey, Fp: fp, Store: store, Root: &tunnel.Root{Jellyfin: jf}, Viewers: func(u string) {
		vmu.Lock()
		defer vmu.Unlock()
		viewers = append(viewers, u)
	}}
	ensured := func() string { vmu.Lock(); defer vmu.Unlock(); return strings.Join(viewers, ",") }
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)

	b := connect(t, gateway, "s1", key, false)
	if got := gateway.User("s1"); got != "user-s1" {
		t.Fatalf("session user = %q, want the offer's user", got)
	}
	if b.say(nil)["type"] != "unpaired" {
		t.Fatal("want unpaired for an unknown key")
	}
	if got := b.fetch(); got != "" || ensured() != "" {
		t.Fatalf("unpaired browser got a tunnel response %q or a Jellyfin viewer (%s)", got, ensured())
	}

	nB := pairing.Nonce()
	h := sha256.Sum256([]byte(nB))
	nA := b.say(map[string]any{"type": "commit", "h": hex.EncodeToString(h[:]), "name": "test phone"})["n"].(string)
	b.send(map[string]any{"type": "reveal", "n": nB})
	waitPending(t, store)
	p := store.Pending()[0]
	if want := pairing.Code(fp, identity.Fingerprint(spki(key)), nA, nB); p.Code != want || p.Name != "test phone" {
		t.Fatalf("pending = %+v, want code %s", p, want)
	}
	if err := store.Decide(p.ID, true); err != nil {
		t.Fatal(err)
	}
	if b.say(nil)["type"] != "approved" {
		t.Fatal("want approved")
	}
	if got := b.fetch(); got != "jellyfin" || ensured() != "user-s1" {
		t.Fatalf("tunnel after approve = %q, viewers ensured %q", got, ensured())
	}

	s2 := connect(t, gateway, "s2", key, false)
	if s2.say(nil)["type"] != "ok" || ensured() != "user-s1,user-s2" {
		t.Fatalf("paired key not recognised on a new session (viewers ensured %q)", ensured())
	}
	// Every tunnel gets its own DTLS certificate: nothing on the wire links them (#427).
	if s2.gwFp == b.gwFp || s2.gwFp == fp {
		t.Fatalf("tunnels share a DTLS fingerprint: %s, %s (identity %s)", b.gwFp, s2.gwFp, fp)
	}
	if m, _ := s2.commit(); m["type"] != "rejected" {
		t.Fatalf("commit on an authorized connection = %v, want rejected", m)
	}
	// A browser whose pin doesn't match (gateway cert changed) forces the code
	// comparison even though its key is allowlisted.
	if connect(t, gateway, "s2b", key, true).say(nil)["type"] != "unpaired" {
		t.Fatal("pair flag must force pairing")
	}
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if connect(t, gateway, "s3", other, false).say(nil)["type"] != "unpaired" {
		t.Fatal("a different key must not inherit the pairing")
	}
	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	if gateway.unauthed != 2 { // s2b, s3: approved s1 and ok s2 left the pre-auth count
		t.Fatalf("%d connections counted as not authenticated, want 2", gateway.unauthed)
	}
}

// An offer without the broker-stamped user, or without a known role, gets no
// session and no answer.
func TestOfferWithoutUserOrRoleRefused(t *testing.T) {
	sdp := &webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: "v=0"}
	for _, m := range []Msg{
		{Type: "offer", Session: "s", Role: tunnel.Admin, SDP: sdp},
		{Type: "offer", Session: "s", User: "u", SDP: sdp},
		{Type: "offer", Session: "s", User: "u", Role: "owner", SDP: sdp},
	} {
		gateway := &Sessions{}
		sent := false
		raw, _ := json.Marshal(m)
		gateway.Handle(raw, func(any) { sent = true })
		if sent || gateway.Active() != 0 || gateway.User("s") != "" {
			t.Fatalf("offer %+v must be refused", m)
		}
	}
}

// Removing a browser on the local page closes its *open* sessions (the tunnel is
// peer-to-peer, so only the gateway closing the PeerConnection stops it); another
// paired browser keeps working, and the removed one is refused on reconnect.
func TestRemoveClosesOpenSessions(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/Users" {
			_, _ = w.Write([]byte(`[{"Name":"home","Id":"0123456789abcdef0123456789abcdef"}]`))
			return
		}
		_, _ = w.Write([]byte("jellyfin"))
	}))
	defer origin.Close()
	dir := t.TempDir()
	idKey, fp, _ := identity.LoadOrCreate(dir)
	store, _ := pairing.Open(dir)
	jf := &tunnel.Jellyfin{Client: http.DefaultClient, URL: origin.URL}
	jf.SetKey("k", "0123456789abcdef0123456789abcdef")
	gateway := &Sessions{Key: idKey, Fp: fp, Store: store, Root: &tunnel.Root{Jellyfin: jf}}
	store.OnRemove = gateway.Drop

	pairKey := func(id string) (*ecdsa.PrivateKey, *browser) {
		key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		b := connect(t, gateway, id, key, false)
		b.say(nil) // unpaired
		nB := pairing.Nonce()
		h := sha256.Sum256([]byte(nB))
		b.say(map[string]any{"type": "commit", "h": hex.EncodeToString(h[:]), "name": id})
		b.send(map[string]any{"type": "reveal", "n": nB})
		waitPending(t, store)
		if err := store.Decide(store.Pending()[0].ID, true); err != nil {
			t.Fatal(err)
		}
		if b.say(nil)["type"] != "approved" {
			t.Fatal("want approved")
		}
		return key, b
	}
	keyA, a1 := pairKey("a1")
	_, other := pairKey("b1")
	a2 := connect(t, gateway, "a2", keyA, false) // a second open session, same key, via "ok"
	if a2.say(nil)["type"] != "ok" {
		t.Fatal("want ok")
	}
	for _, b := range []*browser{a1, a2, other} {
		if b.fetch() != "jellyfin" {
			t.Fatal("tunnel down before remove")
		}
	}

	closed := make(chan struct{}, 2)
	for _, b := range []*browser{a1, a2} {
		b.pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
			if st != webrtc.PeerConnectionStateConnected && st != webrtc.PeerConnectionStateConnecting {
				closed <- struct{}{}
			}
		})
	}
	if err := store.Remove(identity.Fingerprint(spki(keyA))); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		select {
		case <-closed:
		case <-time.After(30 * time.Second):
			t.Fatal("removed browser's open session stayed up")
		}
	}
	if got := other.fetch(); got != "jellyfin" {
		t.Fatalf("other paired browser lost its tunnel: %q", got)
	}
	if connect(t, gateway, "a3", keyA, false).say(nil)["type"] != "unpaired" {
		t.Fatal("removed key must be refused on reconnect")
	}
}

// newGateway is a gateway with an empty allowlist and no media server.
func newGateway(t *testing.T) (*Sessions, *pairing.Store) {
	dir := t.TempDir()
	idKey, fp, _ := identity.LoadOrCreate(dir)
	store, _ := pairing.Open(dir)
	gateway := &Sessions{
		Key:   idKey,
		Fp:    fp,
		Store: store,
		Root:  &tunnel.Root{Jellyfin: &tunnel.Jellyfin{Client: http.DefaultClient}},
	}
	store.OnRemove = gateway.Drop
	return gateway, store
}

// unpaired connects a new key and returns the browser once it may commit.
func unpaired(t *testing.T, gateway *Sessions, id string) (*browser, *ecdsa.PrivateKey) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	b := connect(t, gateway, id, key, false)
	if b.say(nil)["type"] != "unpaired" {
		t.Fatal("want unpaired")
	}
	return b, key
}

// commit sends a commit and returns the gateway's reply and the nonce behind it.
func (b *browser) commit() (map[string]any, string) {
	b.t.Helper()
	nB := pairing.Nonce()
	h := sha256.Sum256([]byte(nB))
	return b.say(map[string]any{"type": "commit", "h": hex.EncodeToString(h[:]), "name": "x"}), nB
}

// slotsFree waits until all MaxPending pairing slots can be taken (and gives
// them back): nothing is holding one.
func slotsFree(t *testing.T, store *pairing.Store) {
	t.Helper()
	testwait.Until(t, 10*time.Second, func() bool {
		got := 0
		for got < pairing.MaxPending && store.Reserve(fmt.Sprint("probe", got)) == nil {
			got++
		}
		for i := range got {
			store.Release(fmt.Sprint("probe", i))
		}
		return got == pairing.MaxPending
	}, "not all %d pairing slots free", pairing.MaxPending)
}

// waitPending waits until a pairing request is on the local page.
func waitPending(t *testing.T, store *pairing.Store) {
	t.Helper()
	testwait.Until(
		t,
		10*time.Second,
		func() bool { return len(store.Pending()) > 0 },
		"no pairing request on the local page",
	)
}

// The handshake runs once per connection: a second `auth` channel on an
// authorised connection is closed without a message, the session keeps its
// recorded key, and Remove for that key still closes it.
func TestSecondAuthChannelRefused(t *testing.T) {
	gateway, store := newGateway(t)
	b, key := unpaired(t, gateway, "s1")
	_, nB := b.commit()
	b.send(map[string]any{"type": "reveal", "n": nB})
	waitPending(t, store)
	if err := store.Decide(store.Pending()[0].ID, true); err != nil {
		t.Fatal(err)
	}
	if b.say(nil)["type"] != "approved" {
		t.Fatal("want approved")
	}
	slotsFree(t, store) // approve gave the slot back

	second, _ := b.pc.CreateDataChannel("auth", nil)
	got, closed := make(chan string, 8), make(chan struct{})
	second.OnMessage(func(m webrtc.DataChannelMessage) { got <- string(m.Data) })
	second.OnClose(func() { close(closed) })
	select {
	case <-closed:
	case <-time.After(10 * time.Second):
		t.Fatal("second auth channel stayed open")
	}
	if len(got) != 0 {
		t.Fatalf("second auth channel was served: %s", <-got)
	}
	fp := identity.Fingerprint(spki(key))
	gateway.mu.Lock()
	recorded := gateway.keys["s1"]
	gateway.mu.Unlock()
	if recorded != fp {
		t.Fatalf("recorded key = %q, want %q", recorded, fp)
	}

	down := make(chan struct{}, 1)
	b.pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st != webrtc.PeerConnectionStateConnected && st != webrtc.PeerConnectionStateConnecting {
			select {
			case down <- struct{}{}:
			default:
			}
		}
	})
	if err := store.Remove(fp); err != nil {
		t.Fatal(err)
	}
	select {
	case <-down:
	case <-time.After(30 * time.Second):
		t.Fatal("Remove did not close the session")
	}
}

// Out of order is refused: a second auth on the channel, a commit before any
// auth, a reveal before any commit (a commit once authorized: TestPairThenTunnel).
func TestOutOfOrderAuthRefused(t *testing.T) {
	gateway, store := newGateway(t)
	b, _ := unpaired(t, gateway, "again")
	if m := b.say(b.auth1); m["type"] != "rejected" {
		t.Fatalf("second auth = %v, want rejected", m)
	}
	if m, _ := connect(t, gateway, "early-commit", nil, false).commit(); m["type"] != "rejected" {
		t.Fatalf("commit before auth = %v, want rejected", m)
	}
	b, _ = unpaired(t, gateway, "early-reveal")
	if m := b.say(map[string]any{"type": "reveal", "n": pairing.Nonce()}); m["type"] != "rejected" {
		t.Fatalf("reveal before commit = %v, want rejected", m)
	}
	b, _ = unpaired(t, gateway, "two-reveals")
	_, nB := b.commit()
	b.send(map[string]any{"type": "reveal", "n": nB})
	if m := b.say(map[string]any{"type": "reveal", "n": nB}); m["type"] != "rejected" {
		t.Fatalf("second reveal = %v, want rejected", m)
	}
	slotsFree(t, store)
}

// One commit per channel: a second one is refused, gets no second nonce, and
// the slot of the first is given back.
func TestSecondCommitRefused(t *testing.T) {
	gateway, store := newGateway(t)
	b, _ := unpaired(t, gateway, "s1")
	if m, _ := b.commit(); m["type"] != "nonce" {
		t.Fatalf("first commit = %v", m)
	}
	if m, _ := b.commit(); m["type"] != "rejected" {
		t.Fatalf("second commit = %v, want rejected", m)
	}
	slotsFree(t, store)
}

// The slot is taken at commit: with all of them held, a commit is refused like
// a full queue and gets no nonce. Bad reveal, Reject and a channel or connection
// closed before reveal each give the slot back.
func TestPairingSlotReservedAtCommit(t *testing.T) {
	gateway, store := newGateway(t)
	held := make([]*browser, pairing.MaxPending)
	for i := range held {
		held[i], _ = unpaired(t, gateway, "held"+string(rune('a'+i)))
		if m, _ := held[i].commit(); m["type"] != "nonce" {
			t.Fatalf("commit %d = %v", i, m)
		}
	}
	extra, _ := unpaired(t, gateway, "extra")
	if m, _ := extra.commit(); m["type"] != "rejected" || m["reason"] != "too many pending pairing requests" {
		t.Fatalf("commit past MaxPending = %v", m)
	}

	held[0].auth.Close() // channel closed without reveal
	held[1].pc.Close()   // connection closed without reveal
	if m := held[2].say(map[string]any{"type": "reveal", "n": "not the committed nonce"}); m["type"] != "rejected" {
		t.Fatalf("bad reveal = %v", m)
	}
	slotsFree(t, store)

	b, _ := unpaired(t, gateway, "denied")
	_, nB := b.commit()
	b.send(map[string]any{"type": "reveal", "n": nB})
	waitPending(t, store)
	if err := store.Decide(store.Pending()[0].ID, false); err != nil {
		t.Fatal(err)
	}
	if m := b.say(nil); m["type"] != "rejected" {
		t.Fatalf("Reject = %v", m)
	}
	slotsFree(t, store)

	// Revealed, then gone: the request leaves the local page with the slot.
	b, _ = unpaired(t, gateway, "gone")
	_, nB = b.commit()
	b.send(map[string]any{"type": "reveal", "n": nB})
	waitPending(t, store)
	b.pc.Close()
	slotsFree(t, store)
	if n := len(store.Pending()); n != 0 {
		t.Fatalf("%d request(s) left on the local page after the connection closed", n)
	}
}

type browser struct {
	t     *testing.T
	pc    *webrtc.PeerConnection
	auth  *webrtc.DataChannel
	in    chan map[string]any
	auth1 map[string]any // the auth message connect sent
	gwFp  string         // the gateway's DTLS fingerprint on this tunnel

	mu    sync.Mutex                // gateway → browser signaling arrives from several goroutines
	early []webrtc.ICECandidateInit // gateway candidates that beat the answer
}

// connect wires a browser peer to the gateway through Handle (no network broker)
// and answers the challenge with a session-bound signature (none if key is nil).
func connect(t *testing.T, gateway *Sessions, id string, key *ecdsa.PrivateKey, pair bool) *browser {
	t.Helper()
	certKey := key
	if certKey == nil {
		certKey, _ = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	}
	bcert, _ := webrtc.GenerateCertificate(certKey) // any cert; its fp is what gets signed
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{Certificates: []webrtc.Certificate{*bcert}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	b := &browser{t: t, pc: pc, in: make(chan map[string]any, 8)}
	// Signaling behaves like production: the gateway reads its control socket one
	// message at a time and the browser sends the offer before any candidate
	// (inOrder); the browser holds candidates that beat the answer (fromGateway).
	// Without both, candidates got dropped and ICE sometimes never connected (#105).
	var inOrder sync.Mutex
	handle := func(m Msg) { raw, _ := json.Marshal(m); gateway.Handle(raw, func(v any) { b.fromGateway(v.(Msg)) }) }
	toGateway := func(m Msg) { inOrder.Lock(); defer inOrder.Unlock(); handle(m) }
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			init := c.ToJSON()
			toGateway(Msg{Type: "ice", Session: id, Candidate: &init})
		}
	})
	b.auth, _ = pc.CreateDataChannel("auth", nil)
	b.auth.OnMessage(func(m webrtc.DataChannelMessage) {
		var v map[string]any
		if err := json.Unmarshal(m.Data, &v); err != nil {
			t.Error(err)
		}
		b.in <- v
	})
	offer, _ := pc.CreateOffer(nil)
	inOrder.Lock() // candidates gathered from here on queue behind the offer
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	role := tunnel.Member // ids starting with "admin" offer as a household admin
	if strings.HasPrefix(id, "admin") {
		role = tunnel.Admin
	}
	handle(Msg{Type: "offer", Session: id, User: "user-" + id, Role: role, SDP: pc.LocalDescription()})
	inOrder.Unlock()

	ch := b.say(nil)
	if ch["type"] != "challenge" {
		t.Fatalf("first auth message = %v", ch)
	}
	pemStr, _ := bcert.PEM()
	blk, _ := pem.Decode([]byte(pemStr))
	b.gwFp = identity.Fingerprint(pc.SCTP().Transport().GetRemoteCertificate())
	checkProof(t, ch, gateway.Fp, b.gwFp, identity.Fingerprint(blk.Bytes))
	if key == nil {
		return b
	}
	msg := sha256.Sum256(pairing.AuthMessage(b.gwFp, identity.Fingerprint(blk.Bytes), ch["n"].(string)))
	r, s, _ := ecdsa.Sign(rand.Reader, key, msg[:])
	sig := append(r.FillBytes(make([]byte, 32)), s.FillBytes(make([]byte, 32))...) // P1363, like WebCrypto
	b.auth1 = map[string]any{"type": "auth", "spki": spki(key), "sig": sig, "pair": pair}
	b.send(b.auth1)
	return b
}

// checkProof is the browser's check of the challenge (#427): the identity key is
// the pinned one and it signed this tunnel's two DTLS fingerprints.
func checkProof(t *testing.T, ch map[string]any, pin, gwDtlsFp, browserDtlsFp string) {
	t.Helper()
	spkiB, _ := base64.StdEncoding.DecodeString(ch["spki"].(string))
	sig, _ := base64.StdEncoding.DecodeString(ch["sig"].(string))
	pub, err := x509.ParsePKIXPublicKey(spkiB)
	if err != nil || identity.Fingerprint(spkiB) != pin || len(sig) != 64 {
		t.Fatalf("challenge key %x (%v), want the pin %s; sig %d bytes", spkiB, err, pin, len(sig))
	}
	h := sha256.Sum256(pairing.GatewayMessage(gwDtlsFp, browserDtlsFp, ch["n"].(string)))
	r, s := new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])
	if !ecdsa.Verify(pub.(*ecdsa.PublicKey), h[:], r, s) {
		t.Fatal("the challenge's proof doesn't verify over this tunnel's fingerprints")
	}
}

// fromGateway applies the gateway's signaling like the frontend (connect.ts):
// candidates that arrive before the answer wait for it.
func (b *browser) fromGateway(m Msg) {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch m.Type {
	case "answer":
		if err := b.pc.SetRemoteDescription(*m.SDP); err != nil {
			b.t.Error(err)
		}
		for _, c := range b.early {
			_ = b.pc.AddICECandidate(c) // fails once the test closed pc: the gateway sends late candidates
		}
		b.early = nil
	case "ice":
		if b.pc.RemoteDescription() == nil {
			b.early = append(b.early, *m.Candidate)
		} else {
			_ = b.pc.AddICECandidate(*m.Candidate) // fails once the test closed pc: the gateway sends late candidates
		}
	}
}

func (b *browser) send(v map[string]any) {
	raw, _ := json.Marshal(v)
	if err := b.auth.SendText(string(raw)); err != nil {
		b.t.Fatal(err)
	}
}

// say sends v (if any) and returns the gateway's next auth message.
func (b *browser) say(v map[string]any) map[string]any {
	b.t.Helper()
	if v != nil {
		b.send(v)
	}
	select {
	case m := <-b.in:
		return m
	case <-time.After(10 * time.Second):
		b.t.Fatal("no auth message from gateway")
		return nil
	}
}

// fetch opens a tunnel channel for an allowlisted GET and returns the body ("" if
// refused). Like the browser: a served response must end with the EOF frame,
// after which the client closes the channel; a refused one is just closed.
func (b *browser) fetch() string {
	d, _ := b.pc.CreateDataChannel("req", nil)
	body := make(chan string, 2)
	var got []byte
	var head, eof atomic.Bool
	// a refused channel (unpaired, over the cap) may be closed before the send: the test sees no answer
	d.OnOpen(func() { _ = d.SendText(`{"method":"GET","url":"/System/Info/Public"}`) })
	d.OnMessage(func(m webrtc.DataChannelMessage) {
		switch {
		case !m.IsString:
			got = append(got, m.Data...)
		case string(m.Data) == `{"eof":true}`:
			if !head.Load() {
				b.t.Error("EOF frame before the response head")
			}
			eof.Store(true)
			body <- string(got)
			d.Close()
		default:
			head.Store(true)
		}
	})
	d.OnClose(func() {
		if head.Load() && !eof.Load() {
			b.t.Error("gateway closed a served channel; the browser closes after EOF")
		}
		body <- string(got)
	})
	select {
	case s := <-body:
		return s
	case <-time.After(10 * time.Second):
		b.t.Fatal("tunnel channel never closed")
		return ""
	}
}

func spki(k *ecdsa.PrivateKey) []byte { b, _ := x509.MarshalPKIXPublicKey(&k.PublicKey); return b }

// The screen relay over real data channels (#179): a TV session opens a screen
// under its pairing name, a phone session lists it and sends a command, the TV
// gets it on its held response; closing the TV's PeerConnection removes it.
func TestScreenOverTunnel(t *testing.T) {
	dir := t.TempDir()
	idKey, fp, _ := identity.LoadOrCreate(dir)
	store, _ := pairing.Open(dir)
	gateway := &Sessions{
		Key:   idKey,
		Fp:    fp,
		Store: store,
		Root:  &tunnel.Root{Jellyfin: &tunnel.Jellyfin{Client: http.DefaultClient}},
	}
	pair := func(id, name string) *browser {
		key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		b := connect(t, gateway, id, key, false)
		b.say(nil) // unpaired
		nB := pairing.Nonce()
		h := sha256.Sum256([]byte(nB))
		b.say(map[string]any{"type": "commit", "h": hex.EncodeToString(h[:]), "name": name})
		b.send(map[string]any{"type": "reveal", "n": nB})
		waitPending(t, store)
		if err := store.Decide(store.Pending()[0].ID, true); err != nil {
			t.Fatal(err)
		}
		if b.say(nil)["type"] != "approved" {
			t.Fatal("want approved")
		}
		return b
	}
	tv, phone := pair("tv", "Living room TV"), pair("phone", "Phone")

	// The offer's role stays on the session (#194): on an admin-only endpoint a
	// member's tunnel request is refused, an admin's passes the gate.
	gateway.Root.API = tunnel.NewRouter()
	screen.Register(gateway.Root.API)
	gateway.Root.API.Handle("GET "+tunnel.StatusPath, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), tunnel.AdminOnly)
	for b, want := range map[*browser]string{phone: `"status":403`, pair("admin-laptop", "Laptop"): `"status":204`} {
		got, d := b.open(`{"method":"GET","url":"/streamiq/status"}`)
		if head := b.frame(got); !strings.Contains(head, want) {
			t.Fatalf("admin-only endpoint: head = %s, want %s", head, want)
		}
		d.Close()
	}

	frames, _ := tv.open(`{"method":"GET","url":"/streamiq/screen"}`)
	if head := tv.frame(frames); !strings.Contains(head, `"status":200`) {
		t.Fatalf("screen head = %s", head)
	}
	var screens []struct{ ID, Name string } // the TV's head came after the screen registered
	if err := json.Unmarshal([]byte(phone.body(`{"method":"GET","url":"/streamiq/screens"}`)), &screens); err != nil {
		t.Fatal(err)
	}
	if len(screens) != 1 || screens[0].Name != "Living room TV" {
		t.Fatalf("screens = %+v", screens)
	}
	phone.body(`{"method":"POST","url":"/streamiq/screens/` + screens[0].ID + `","body":"{\"type\":\"pause\"}"}`)
	if got := tv.frame(frames); got != `{"type":"pause"}`+"\n" {
		t.Fatalf("TV got %q", got)
	}

	tv.pc.Close()
	testwait.Until(t, 30*time.Second, func() bool {
		return phone.body(`{"method":"GET","url":"/streamiq/screens"}`) == "[]"
	}, "screen outlived the TV's session")
}

// open sends one tunnel request and returns its frames as they arrive (head
// first, then each body chunk as text).
func (b *browser) open(req string) (chan string, *webrtc.DataChannel) {
	d, _ := b.pc.CreateDataChannel("req", nil)
	frames := make(chan string, 16)
	d.OnOpen(func() {
		if err := d.SendText(req); err != nil {
			b.t.Error(err)
		}
	})
	d.OnMessage(func(m webrtc.DataChannelMessage) { frames <- string(m.Data) })
	return frames, d
}

// frame waits for the next frame, failing after 10 s.
func (b *browser) frame(frames chan string) string {
	b.t.Helper()
	select {
	case f := <-frames:
		return f
	case <-time.After(10 * time.Second):
		b.t.Fatal("no frame from the gateway")
		return ""
	}
}

// body sends one tunnel request and returns its whole body; closes after EOF like the client.
func (b *browser) body(req string) string {
	b.t.Helper()
	frames, d := b.open(req)
	defer d.Close()
	var got []byte
	b.frame(frames) // head
	for {
		if f := b.frame(frames); f == `{"eof":true}` {
			return string(got)
		} else {
			got = append(got, f...)
		}
	}
}

// At most tunnel.MaxChannels tunnel channels are served at once on a connection:
// the one over the cap is closed without a response, and once a served one ends
// the next request goes through again.
func TestTunnelChannelCap(t *testing.T) {
	var inFlight atomic.Int32
	release := make(chan struct{})
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		inFlight.Add(1)
		<-release
		_, _ = w.Write([]byte("jellyfin"))
	}))
	defer origin.Close()
	gateway, store := newGateway(t)
	gateway.Root.Jellyfin.URL = origin.URL
	gateway.Root.Jellyfin.SetKey("k", "0123456789abcdef0123456789abcdef")
	b, _ := unpaired(t, gateway, "s1")
	_, nB := b.commit()
	b.send(map[string]any{"type": "reveal", "n": nB})
	waitPending(t, store)
	if err := store.Decide(store.Pending()[0].ID, true); err != nil {
		t.Fatal(err)
	}
	if b.say(nil)["type"] != "approved" {
		t.Fatal("want approved")
	}

	held := make(chan string, tunnel.MaxChannels)
	for range tunnel.MaxChannels {
		go func() { held <- b.fetch() }()
	}
	testwait.Until(t, 10*time.Second, func() bool { return inFlight.Load() >= tunnel.MaxChannels },
		"not all %d channels served", tunnel.MaxChannels)
	if got := b.fetch(); got != "" || inFlight.Load() != tunnel.MaxChannels {
		t.Fatalf("channel over the cap: body %q, %d requests reached Jellyfin", got, inFlight.Load())
	}

	close(release)
	for range tunnel.MaxChannels {
		if got := <-held; got != "jellyfin" {
			t.Fatalf("held request = %q", got)
		}
	}
	testwait.Until(t, 10*time.Second, func() bool { return b.fetch() == "jellyfin" }, // slots free as the closes arrive
		"cap did not free up after the served channels ended")
}

// The gateway reports each tunnel once when it ends (#390), read before the
// PeerConnection closes: a paired one with its route and bytes and no failure,
// an unpaired one with why it never got the tunnel. A served one names its use and
// active time, one without requests neither. A second bye reports nothing. The report
// goes to the history only, never on the control socket.
func TestTunnelReportedOnceOnEnd(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/Users" {
			_, _ = w.Write([]byte(`[{"Name":"home","Id":"0123456789abcdef0123456789abcdef"}]`))
			return
		}
		_, _ = w.Write([]byte("jellyfin"))
	}))
	defer origin.Close()
	dir := t.TempDir()
	idKey, fp, _ := identity.LoadOrCreate(dir)
	store, _ := pairing.Open(dir)
	jf := &tunnel.Jellyfin{Client: http.DefaultClient, URL: origin.URL}
	jf.SetKey("k", "0123456789abcdef0123456789abcdef")
	gateway := &Sessions{Key: idKey, Fp: fp, Store: store, Root: &tunnel.Root{Jellyfin: jf}}
	var ended []string // the history's lines: session/user
	var mu sync.Mutex
	reps := make(chan tunnel.Report, 4)
	gateway.Ended = func(r tunnel.Report, user string, start time.Time, _ int) {
		mu.Lock()
		defer mu.Unlock()
		if start.IsZero() {
			t.Error("a line without its start")
		}
		ended = append(ended, r.Session+"/"+user)
		reps <- r
	}
	next := func() tunnel.Report {
		select {
		case r := <-reps:
			return r
		case <-time.After(10 * time.Second):
			t.Fatal("no tunnel report")
			return tunnel.Report{}
		}
	}
	bye := func(id string) {
		raw, _ := json.Marshal(Msg{Type: "bye", Session: id})
		gateway.Handle(raw, func(any) { t.Error("a report on the offer's socket") })
	}

	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	b := connect(t, gateway, "s1", key, false)
	b.say(nil) // unpaired
	nB := pairing.Nonce()
	h := sha256.Sum256([]byte(nB))
	b.say(map[string]any{"type": "commit", "h": hex.EncodeToString(h[:]), "name": "phone"})
	b.send(map[string]any{"type": "reveal", "n": nB})
	waitPending(t, store)
	if err := store.Decide(store.Pending()[0].ID, true); err != nil {
		t.Fatal(err)
	}
	if b.say(nil)["type"] != "approved" || b.fetch() != "jellyfin" {
		t.Fatal("want a working tunnel")
	}
	bye("s1")
	r := next()
	if r.Session != "s1" || r.Failure != nil || r.Relay || r.BytesSent == 0 || r.BytesReceived == 0 ||
		r.Use != "browsing" || r.ActiveMs == nil || *r.ActiveMs <= 0 {
		t.Fatalf("report of a served tunnel = %+v", r)
	}

	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	u := connect(t, gateway, "s2", other, false)
	u.say(nil) // unpaired
	bye("s2")
	if r := next(); r.Failure == nil || *r.Failure != "unpaired" || r.Use != "" || r.ActiveMs != nil {
		t.Fatalf("report of an unpaired tunnel = %+v", r)
	}
	bye("s2")
	select {
	case r := <-reps:
		t.Fatalf("second report %+v", r)
	case <-time.After(time.Second): // also covers the Closed state callback that follows
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(ended, ",") != "s1/user-s1,s2/user-s2" {
		t.Fatalf("history lines %v, want one per tunnel with its user", ended)
	}
}

// Forced relay (#390): only a browser that signaled nothing but relays counts as
// relay-only; the end-of-candidates "" counts as nothing.
func TestSignaledKinds(t *testing.T) {
	var c signaled
	c.saw("candidate:1 1 udp 41885439 203.0.113.7 3478 typ relay raddr 0.0.0.0 rport 0 generation 0")
	c.saw("")
	if !c.relay.Load() || c.other.Load() {
		t.Fatal("want relay-only")
	}
	c.saw("candidate:2 1 udp 2122260223 192.168.1.5 50000 typ host generation 0")
	if !c.other.Load() {
		t.Fatal("a host candidate must count as other")
	}
}

// The tunnel report's relay and IPv6 flags (#520): either side relayed, a prflx
// remote only when the browser signaled nothing but relays, and IPv6 on either side.
func TestClassify(t *testing.T) {
	relayOnly, mixed, none := &signaled{}, &signaled{}, &signaled{}
	relayOnly.relay.Store(true)
	mixed.relay.Store(true)
	mixed.other.Store(true)
	const v4, v6 = "192.0.2.1", "2001:db8::1"
	host, relay, prflx, srflx := webrtc.ICECandidateTypeHost, webrtc.ICECandidateTypeRelay, webrtc.ICECandidateTypePrflx, webrtc.ICECandidateTypeSrflx
	for _, c := range []struct {
		name                  string
		local, remote         webrtc.ICECandidateType
		localAddr, remoteAddr string
		cands                 *signaled
		wantRelay, wantIpv6   bool
	}{
		{"host pair", host, host, v4, v4, mixed, false, false},
		{"our relay", relay, host, v4, v4, none, true, false},
		{"their relay", host, relay, v4, v4, none, true, false},
		{"prflx, relays only signaled", host, prflx, v4, v4, relayOnly, true, false},
		{"prflx, relays and others signaled", host, prflx, v4, v4, mixed, false, false},
		{"prflx, nothing signaled", host, prflx, v4, v4, none, false, false},
		{"srflx, relays only signaled", host, srflx, v4, v4, relayOnly, false, false},
		{"IPv6 here", host, host, v6, v4, none, false, true},
		{"IPv6 there", host, host, v4, v6, none, false, true},
		{"mDNS there", host, host, v4, "abc.local", none, false, false},
	} {
		p := &webrtc.ICECandidatePair{
			Local:  &webrtc.ICECandidate{Typ: c.local, Address: c.localAddr},
			Remote: &webrtc.ICECandidate{Typ: c.remote, Address: c.remoteAddr},
		}
		if relay, ipv6 := classify(p, c.cands); relay != c.wantRelay || ipv6 != c.wantIpv6 {
			t.Errorf("%s: relay %v ipv6 %v, want %v %v", c.name, relay, ipv6, c.wantRelay, c.wantIpv6)
		}
	}
}

// A served tunnel the browser closes (its PeerConnection, no bye) is reported
// without a failure (#520): only ICE failing before it came up is "ice failed" (#485).
func TestBrowserCloseReportsNoFailure(t *testing.T) {
	gateway, store := newGateway(t)
	reps := make(chan tunnel.Report, 4)
	gateway.Ended = func(r tunnel.Report, _ string, _ time.Time, _ int) { reps <- r }
	b, _ := unpaired(t, gateway, "s1")
	_, nB := b.commit()
	b.send(map[string]any{"type": "reveal", "n": nB})
	waitPending(t, store)
	if err := store.Decide(store.Pending()[0].ID, true); err != nil {
		t.Fatal(err)
	}
	if b.say(nil)["type"] != "approved" {
		t.Fatal("want approved")
	}
	b.pc.Close()
	select {
	case r := <-reps:
		if r.Failure != nil {
			t.Fatalf("report of a tunnel the browser closed = failure %q", *r.Failure)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("no tunnel report after the browser closed")
	}
}

// Handle ignores what it can't act on (#520): an offer without a session id, a
// second offer for a running session, and candidates without a session or
// without a candidate. None of them answers, starts a session or panics.
func TestSignalingIgnored(t *testing.T) {
	gateway, _ := newGateway(t)
	pc, _ := webrtc.NewPeerConnection(webrtc.Configuration{})
	t.Cleanup(func() { pc.Close() })
	if _, err := pc.CreateDataChannel("auth", nil); err != nil {
		t.Fatal(err)
	}
	offer, _ := pc.CreateOffer(nil)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	var answers atomic.Int32
	handle := func(m Msg) {
		raw, _ := json.Marshal(m)
		gateway.Handle(raw, func(v any) {
			if m, ok := v.(Msg); ok && m.Type == "answer" {
				answers.Add(1)
			}
		})
	}
	offerFor := func(id string) Msg {
		return Msg{Type: "offer", Session: id, User: "u", Role: tunnel.Member, SDP: pc.LocalDescription()}
	}
	handle(offerFor(""))
	if answers.Load() != 0 || gateway.Active() != 0 {
		t.Fatal("an offer without a session id was answered")
	}
	handle(offerFor("s"))
	handle(offerFor("s"))
	if answers.Load() != 1 || gateway.Active() != 1 {
		t.Fatalf("two offers for one session: %d answers, %d sessions", answers.Load(), gateway.Active())
	}
	handle(
		Msg{
			Type:      "ice",
			Session:   "other",
			Candidate: &webrtc.ICECandidateInit{Candidate: "candidate:1 1 udp 1 192.0.2.1 1 typ host"},
		},
	)
	handle(Msg{Type: "ice", Session: "s"})
	handle(Msg{Type: "bye", Session: "s"})
}

// Drop of a key without open sessions closes nothing and says nothing (#520).
func TestDropNoSessions(t *testing.T) {
	var buf strings.Builder
	orig := log.Writer()
	log.SetOutput(&buf)
	gateway, _ := newGateway(t)
	gateway.Drop("no-such-key")
	log.SetOutput(orig) // under the logger's lock: no later write (pion's goroutines from other tests) races the read
	if strings.Contains(buf.String(), "removed browser") {
		t.Fatalf("Drop without sessions logged %q", buf.String())
	}
}

// An auth handled after its session ended records no key: the ender that
// would remove it has run already (#635).
func TestRecordAfterEnd(t *testing.T) {
	s := &Sessions{keys: map[string]string{}, ends: map[string]func(bool){"live": func(bool) {}}}
	if !s.record("live", "fp") || s.keys["live"] != "fp" {
		t.Fatalf("live session: keys %v", s.keys)
	}
	if s.record("ended", "fp") || len(s.keys) != 1 {
		t.Fatalf("ended session recorded: keys %v", s.keys)
	}
}

// A pairing name is trimmed and cut to 60 bytes; an empty one is "browser" (#520).
func TestTrim(t *testing.T) {
	for in, want := range map[string]string{
		"  phone  ":             "phone",
		"   ":                   "browser",
		strings.Repeat("a", 60): strings.Repeat("a", 60),
		strings.Repeat("a", 61): strings.Repeat("a", 60),
	} {
		if got := trim(in); got != want {
			t.Errorf("trim(%q) = %q, want %q", in, got, want)
		}
	}
}

// A Disconnected session lives on (#485): it recovers, or pion turns it Failed.
func TestEnds(t *testing.T) {
	for st, want := range map[webrtc.PeerConnectionState]bool{
		webrtc.PeerConnectionStateConnected:    false,
		webrtc.PeerConnectionStateDisconnected: false,
		webrtc.PeerConnectionStateFailed:       true,
		webrtc.PeerConnectionStateClosed:       true,
	} {
		if endsSession(st) != want {
			t.Errorf("endsSession(%s) = %v, want %v", st, !want, want)
		}
	}
}

// A tunnel that came up and then failed keeps its route in the report (#485):
// pion has no selected pair any more, the one kept while connected counts.
func TestReportKeepsLastPair(t *testing.T) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	last := &webrtc.ICECandidatePair{
		Local: &webrtc.ICECandidate{
			Typ:      webrtc.ICECandidateTypeRelay,
			Address:  "192.0.2.1",
			Protocol: webrtc.ICEProtocolUDP,
		},
		Remote: &webrtc.ICECandidate{Typ: webrtc.ICECandidateTypeHost, Address: "2001:db8::1"},
	}
	r := report("s", pc, &signaled{}, last, failure(false, true, ""))
	if !r.Relay || !r.Ipv6 || r.Failure != nil {
		t.Fatalf("report after Failed = %+v", r)
	}
}

const relayCand = "candidate:9 1 udp 41885439 203.0.113.7 3478 typ relay raddr 0.0.0.0 rport 0 generation 0"

// Relay off: a browser's trickled relay candidate never reaches pion, with the relay
// on it does (both connect over host candidates).
func TestRelayOffDropsRemoteRelayCandidates(t *testing.T) {
	for _, on := range []bool{true, false} {
		gateway, _ := newGateway(t)
		gateway.Relay = func() bool { return on }
		unpaired(t, gateway, "s1")
		raw, _ := json.Marshal(Msg{Type: "ice", Session: "s1",
			Candidate: &webrtc.ICECandidateInit{Candidate: relayCand, SDPMid: ptr("0")}})
		gateway.Handle(raw, func(any) {})
		gateway.mu.Lock()
		pc := gateway.pcs["s1"]
		gateway.mu.Unlock()
		// pion adds a remote candidate in a goroutine (ice Agent.AddRemoteCandidate): wait
		// for it to land. With the relay off it is never handed to pion, so no wait.
		if on {
			testwait.Until(t, 5*time.Second, func() bool { return remoteRelays(pc) },
				"relay on: pion never got the relay candidate")
		} else if remoteRelays(pc) {
			t.Error("relay off: pion has the relay candidate")
		}
	}
}

func remoteRelays(pc *webrtc.PeerConnection) bool {
	for _, s := range pc.GetStats() {
		if c, ok := s.(webrtc.ICECandidateStats); ok && c.Type == webrtc.StatsTypeRemoteCandidate &&
			c.CandidateType == webrtc.ICECandidateTypeRelay {
			return true
		}
	}
	return false
}

// An offer's relay candidates go when the relay is off; everything else stays.
func TestDropRelays(t *testing.T) {
	host := "a=candidate:2 1 udp 2122260223 192.168.1.5 50000 typ host generation 0\r\n"
	sdp := "v=0\r\n" + host + "a=" + relayCand + "\r\na=end-of-candidates\r\n"
	if got, want := dropRelays(sdp), "v=0\r\n"+host+"a=end-of-candidates\r\n"; got != want {
		t.Fatalf("%q, want %q", got, want)
	}
}

// Relay off: a pair over a relay must not stay, also one that reached us as prflx
// from a browser that signaled a relay; a prflx without one is a plain NAT.
func TestRelayed(t *testing.T) {
	sawRelay, none := &signaled{}, &signaled{}
	sawRelay.saw(relayCand)
	sawRelay.saw("candidate:2 1 udp 2122260223 192.168.1.5 50000 typ host generation 0")
	pair := func(remote webrtc.ICECandidateType) *webrtc.ICECandidatePair {
		return &webrtc.ICECandidatePair{Local: &webrtc.ICECandidate{Typ: webrtc.ICECandidateTypeHost},
			Remote: &webrtc.ICECandidate{Typ: remote}}
	}
	if !relayed(pair(webrtc.ICECandidateTypeRelay), none) || !relayed(pair(webrtc.ICECandidateTypePrflx), sawRelay) ||
		relayed(pair(webrtc.ICECandidateTypePrflx), none) || relayed(pair(webrtc.ICECandidateTypeHost), sawRelay) {
		t.Fatal("relayed")
	}
}
