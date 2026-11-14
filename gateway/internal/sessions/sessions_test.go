package sessions

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
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
	"streamiq/gateway/internal/tunnel"
)

// A browser (played by a second Pion peer) is refused tunnel channels until it
// pairs; after Approve on the "local page" a tunneled GET goes through, and a
// fresh session with the same key is let straight in.
func TestPairThenTunnel(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/Users" {
			w.Write([]byte(`[{"Name":"home","Id":"0123456789abcdef0123456789abcdef"}]`))
			return
		}
		w.Write([]byte("jellyfin"))
	}))
	defer origin.Close()
	dir := t.TempDir()
	cert, fp, err := identity.LoadOrCreate(dir)
	if err != nil {
		t.Fatal(err)
	}
	store, _ := pairing.Open(dir)
	jf := &tunnel.Jellyfin{Client: http.DefaultClient, URL: origin.URL}
	jf.SetKey("k", "0123456789abcdef0123456789abcdef")
	var vmu sync.Mutex
	var viewers []string // users whose viewer was ensured: only once paired (#195)
	gateway := &Sessions{Cert: cert, Fp: fp, Store: store, Jellyfin: jf, Viewers: func(u string) {
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
	for len(store.Pending()) == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	p := store.Pending()[0]
	if want := pairing.Code(fp, identity.Fingerprint(spki(key)), nA, nB); p.Code != want || p.Name != "test phone" {
		t.Fatalf("pending = %+v, want code %s", p, want)
	}
	store.Decide(p.ID, true)
	if b.say(nil)["type"] != "approved" {
		t.Fatal("want approved")
	}
	if got := b.fetch(); got != "jellyfin" || ensured() != "user-s1" {
		t.Fatalf("tunnel after approve = %q, viewers ensured %q", got, ensured())
	}

	if connect(t, gateway, "s2", key, false).say(nil)["type"] != "ok" || ensured() != "user-s1,user-s2" {
		t.Fatalf("paired key not recognised on a new session (viewers ensured %q)", ensured())
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
			w.Write([]byte(`[{"Name":"home","Id":"0123456789abcdef0123456789abcdef"}]`))
			return
		}
		w.Write([]byte("jellyfin"))
	}))
	defer origin.Close()
	dir := t.TempDir()
	cert, fp, _ := identity.LoadOrCreate(dir)
	store, _ := pairing.Open(dir)
	jf := &tunnel.Jellyfin{Client: http.DefaultClient, URL: origin.URL}
	jf.SetKey("k", "0123456789abcdef0123456789abcdef")
	gateway := &Sessions{Cert: cert, Fp: fp, Store: store, Jellyfin: jf}
	store.OnRemove = gateway.Drop

	pairKey := func(id string) (*ecdsa.PrivateKey, *browser) {
		key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		b := connect(t, gateway, id, key, false)
		b.say(nil) // unpaired
		nB := pairing.Nonce()
		h := sha256.Sum256([]byte(nB))
		b.say(map[string]any{"type": "commit", "h": hex.EncodeToString(h[:]), "name": id})
		b.send(map[string]any{"type": "reveal", "n": nB})
		for len(store.Pending()) == 0 {
			time.Sleep(10 * time.Millisecond)
		}
		store.Decide(store.Pending()[0].ID, true)
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
	cert, fp, _ := identity.LoadOrCreate(dir)
	store, _ := pairing.Open(dir)
	gateway := &Sessions{Cert: cert, Fp: fp, Store: store, Jellyfin: &tunnel.Jellyfin{Client: http.DefaultClient}}
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
	for start := time.Now(); ; time.Sleep(10 * time.Millisecond) {
		got := 0
		for got < pairing.MaxPending && store.Reserve() == nil {
			got++
		}
		for range got {
			store.Release()
		}
		if got == pairing.MaxPending {
			return
		}
		if time.Since(start) > 10*time.Second {
			t.Fatalf("only %d of %d pairing slots free", got, pairing.MaxPending)
		}
	}
}

// The handshake runs once per connection: a second `auth` channel on an
// authorised connection is closed without a message, the session keeps its
// recorded key, and Remove for that key still closes it.
func TestSecondAuthChannelRefused(t *testing.T) {
	gateway, store := newGateway(t)
	b, key := unpaired(t, gateway, "s1")
	_, nB := b.commit()
	b.send(map[string]any{"type": "reveal", "n": nB})
	for len(store.Pending()) == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	store.Decide(store.Pending()[0].ID, true)
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
	for len(store.Pending()) == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	store.Decide(store.Pending()[0].ID, false)
	if m := b.say(nil); m["type"] != "rejected" {
		t.Fatalf("Reject = %v", m)
	}
	slotsFree(t, store)

	// Revealed, then gone: the request leaves the local page with the slot.
	b, _ = unpaired(t, gateway, "gone")
	_, nB = b.commit()
	b.send(map[string]any{"type": "reveal", "n": nB})
	for len(store.Pending()) == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	b.pc.Close()
	slotsFree(t, store)
	if n := len(store.Pending()); n != 0 {
		t.Fatalf("%d request(s) left on the local page after the connection closed", n)
	}
}

type browser struct {
	t    *testing.T
	pc   *webrtc.PeerConnection
	auth *webrtc.DataChannel
	in   chan map[string]any

	mu    sync.Mutex                // gateway → browser signaling arrives from several goroutines
	early []webrtc.ICECandidateInit // gateway candidates that beat the answer
}

// connect wires a browser peer to the gateway through Handle (no network broker)
// and answers the challenge with a session-bound signature.
func connect(t *testing.T, gateway *Sessions, id string, key *ecdsa.PrivateKey, pair bool) *browser {
	t.Helper()
	bcert, _ := webrtc.GenerateCertificate(key) // any cert; its fp is what gets signed
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
		json.Unmarshal(m.Data, &v)
		b.in <- v
	})
	offer, _ := pc.CreateOffer(nil)
	inOrder.Lock() // candidates gathered from here on queue behind the offer
	pc.SetLocalDescription(offer)
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
	msg := sha256.Sum256(pairing.AuthMessage(gateway.Fp, identity.Fingerprint(blk.Bytes), ch["n"].(string)))
	r, s, _ := ecdsa.Sign(rand.Reader, key, msg[:])
	sig := append(r.FillBytes(make([]byte, 32)), s.FillBytes(make([]byte, 32))...) // P1363, like WebCrypto
	b.send(map[string]any{"type": "auth", "spki": spki(key), "sig": sig, "pair": pair})
	return b
}

// fromGateway applies the gateway's signaling like the frontend (connect.ts):
// candidates that arrive before the answer wait for it.
func (b *browser) fromGateway(m Msg) {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch m.Type {
	case "answer":
		b.pc.SetRemoteDescription(*m.SDP)
		for _, c := range b.early {
			b.pc.AddICECandidate(c)
		}
		b.early = nil
	case "ice":
		if b.pc.RemoteDescription() == nil {
			b.early = append(b.early, *m.Candidate)
		} else {
			b.pc.AddICECandidate(*m.Candidate)
		}
	}
}

func (b *browser) send(v map[string]any) { raw, _ := json.Marshal(v); b.auth.SendText(string(raw)) }

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
	d.OnOpen(func() { d.SendText(`{"method":"GET","url":"/System/Info/Public"}`) })
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
	cert, fp, _ := identity.LoadOrCreate(dir)
	store, _ := pairing.Open(dir)
	gateway := &Sessions{Cert: cert, Fp: fp, Store: store, Jellyfin: &tunnel.Jellyfin{Client: http.DefaultClient}}
	pair := func(id, name string) *browser {
		key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		b := connect(t, gateway, id, key, false)
		b.say(nil) // unpaired
		nB := pairing.Nonce()
		h := sha256.Sum256([]byte(nB))
		b.say(map[string]any{"type": "commit", "h": hex.EncodeToString(h[:]), "name": name})
		b.send(map[string]any{"type": "reveal", "n": nB})
		for len(store.Pending()) == 0 {
			time.Sleep(10 * time.Millisecond)
		}
		store.Decide(store.Pending()[0].ID, true)
		if b.say(nil)["type"] != "approved" {
			t.Fatal("want approved")
		}
		return b
	}
	tv, phone := pair("tv", "Living room TV"), pair("phone", "Phone")

	// The offer's role stays on the session (#194): on an admin-only endpoint a
	// member's tunnel request is refused, an admin's passes the gate (no status
	// source in this test, so it then gets 404).
	tunnel.AdminOnly.Store(tunnel.StatusPath, true)
	t.Cleanup(func() { tunnel.AdminOnly.Delete(tunnel.StatusPath) })
	for b, want := range map[*browser]string{phone: `"status":403`, pair("admin-laptop", "Laptop"): `"status":404`} {
		got, d := b.open(`{"method":"GET","url":"/streamiq/status"}`)
		if head := b.frame(got); !strings.Contains(head, want) {
			t.Fatalf("admin-only endpoint: head = %s, want %s", head, want)
		}
		d.Close()
	}
	tunnel.AdminOnly.Delete(tunnel.StatusPath)

	frames, _ := tv.open(`{"method":"GET","url":"/streamiq/screen"}`)
	if head := tv.frame(frames); !strings.Contains(head, `"status":200`) {
		t.Fatalf("screen head = %s", head)
	}
	var screens []struct{ ID, Name string } // the TV's head came after the screen registered
	json.Unmarshal([]byte(phone.body(`{"method":"GET","url":"/streamiq/screens"}`)), &screens)
	if len(screens) != 1 || screens[0].Name != "Living room TV" {
		t.Fatalf("screens = %+v", screens)
	}
	phone.body(`{"method":"POST","url":"/streamiq/screens/` + screens[0].ID + `","body":"{\"type\":\"pause\"}"}`)
	if got := tv.frame(frames); got != `{"type":"pause"}`+"\n" {
		t.Fatalf("TV got %q", got)
	}

	tv.pc.Close()
	for start := time.Now(); phone.body(`{"method":"GET","url":"/streamiq/screens"}`) != "[]"; {
		if time.Since(start) > 30*time.Second {
			t.Fatal("screen outlived the TV's session")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// open sends one tunnel request and returns its frames as they arrive (head
// first, then each body chunk as text).
func (b *browser) open(req string) (chan string, *webrtc.DataChannel) {
	d, _ := b.pc.CreateDataChannel("req", nil)
	frames := make(chan string, 16)
	d.OnOpen(func() { d.SendText(req) })
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
		w.Write([]byte("jellyfin"))
	}))
	defer origin.Close()
	gateway, store := newGateway(t)
	gateway.Jellyfin.URL = origin.URL
	gateway.Jellyfin.SetKey("k", "0123456789abcdef0123456789abcdef")
	b, _ := unpaired(t, gateway, "s1")
	_, nB := b.commit()
	b.send(map[string]any{"type": "reveal", "n": nB})
	for len(store.Pending()) == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	store.Decide(store.Pending()[0].ID, true)
	if b.say(nil)["type"] != "approved" {
		t.Fatal("want approved")
	}

	held := make(chan string, tunnel.MaxChannels)
	for range tunnel.MaxChannels {
		go func() { held <- b.fetch() }()
	}
	for start := time.Now(); inFlight.Load() < tunnel.MaxChannels; time.Sleep(10 * time.Millisecond) {
		if time.Since(start) > 10*time.Second {
			t.Fatalf("only %d of %d channels served", inFlight.Load(), tunnel.MaxChannels)
		}
	}
	if got := b.fetch(); got != "" || inFlight.Load() != tunnel.MaxChannels {
		t.Fatalf("channel over the cap: body %q, %d requests reached Jellyfin", got, inFlight.Load())
	}

	close(release)
	for range tunnel.MaxChannels {
		if got := <-held; got != "jellyfin" {
			t.Fatalf("held request = %q", got)
		}
	}
	for start := time.Now(); b.fetch() != "jellyfin"; time.Sleep(10 * time.Millisecond) { // slots free as the closes arrive
		if time.Since(start) > 10*time.Second {
			t.Fatal("cap did not free up after the served channels ended")
		}
	}
}
