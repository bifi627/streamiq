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
	gateway := &Sessions{Cert: cert, Fp: fp, Store: store, Jellyfin: jf}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)

	b := connect(t, gateway, "s1", key, false)
	if b.say(nil)["type"] != "unpaired" {
		t.Fatal("want unpaired for an unknown key")
	}
	if got := b.fetch(); got != "" {
		t.Fatalf("unpaired browser got a tunnel response %q", got)
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
	if got := b.fetch(); got != "jellyfin" {
		t.Fatalf("tunnel after approve = %q", got)
	}

	if connect(t, gateway, "s2", key, false).say(nil)["type"] != "ok" {
		t.Fatal("paired key not recognised on a new session")
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

type browser struct {
	t    *testing.T
	pc   *webrtc.PeerConnection
	auth *webrtc.DataChannel
	in   chan map[string]any
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
	toGateway := func(m Msg) { raw, _ := json.Marshal(m); gateway.Handle(raw, func(v any) { b.fromGateway(v.(Msg)) }) }
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
	pc.SetLocalDescription(offer)
	toGateway(Msg{Type: "offer", Session: id, SDP: pc.LocalDescription()})

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

func (b *browser) fromGateway(m Msg) {
	switch m.Type {
	case "answer":
		b.pc.SetRemoteDescription(*m.SDP)
	case "ice":
		b.pc.AddICECandidate(*m.Candidate)
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

// fetch opens a tunnel channel for an allowlisted GET and returns the body ("" if refused).
func (b *browser) fetch() string {
	d, _ := b.pc.CreateDataChannel("req", nil)
	body := make(chan string, 1)
	var got []byte
	d.OnOpen(func() { d.SendText(`{"method":"GET","url":"/System/Info/Public"}`) })
	d.OnMessage(func(m webrtc.DataChannelMessage) {
		if !m.IsString {
			got = append(got, m.Data...)
		}
	})
	d.OnClose(func() { body <- string(got) })
	select {
	case s := <-body:
		return s
	case <-time.After(10 * time.Second):
		b.t.Fatal("tunnel channel never closed")
		return ""
	}
}

func spki(k *ecdsa.PrivateKey) []byte { b, _ := x509.MarshalPKIXPublicKey(&k.PublicKey); return b }
