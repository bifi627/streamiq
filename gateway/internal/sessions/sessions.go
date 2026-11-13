// Package sessions serves browsers brokered over the control socket (design:
// specs/2026-11-01-streamiq-agent-pairing-design.md, "Concurrent sessions" and
// "Connection gating"): one PeerConnection per broker session, an `auth` data
// channel that proves the browser's client key bound to this DTLS session, and
// tunnel channels only once that key is on the allowlist — or gets approved.
package sessions

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/pion/webrtc/v4"

	"streamiq/gateway/internal/identity"
	"streamiq/gateway/internal/pairing"
	"streamiq/gateway/internal/tunnel"
)

// Msg is the broker envelope on the control socket (docs/protocol.md).
type Msg struct {
	Type      string                     `json:"type"` // offer | answer | ice | bye
	Session   string                     `json:"session"`
	User      string                     `json:"user,omitempty"` // offer only: the signed-in user's users.id, stamped by the broker
	Role      string                     `json:"role,omitempty"` // offer only: that user's role in this gateway's household (admin | member)
	SDP       *webrtc.SessionDescription `json:"sdp,omitempty"`
	Candidate *webrtc.ICECandidateInit   `json:"candidate,omitempty"`
}

type Sessions struct {
	Cert     *webrtc.Certificate
	Fp       string // our DTLS fingerprint
	Store    *pairing.Store
	Jellyfin *tunnel.Jellyfin // the tunnel's origin + policy
	// Viewers makes sure a user has their own Jellyfin viewer (#195), once the
	// session's device is paired: an offer alone (the API) makes nothing. nil = none.
	Viewers func(user string)

	mu    sync.Mutex
	pcs   map[string]*webrtc.PeerConnection
	keys  map[string]string // session id → client key fp, recorded before the allowlist check
	users map[string]string // session id → user id from the offer (who acts; the key says which device)
	API   *webrtc.API       // from NewAPI; nil = Pion defaults
}

// NewAPI builds the one WebRTC API all sessions share. Native runs need
// nothing (zero value = Pion defaults). In Docker the container's IPs are
// useless to browsers, so STREAMIQ_ICE_PORT pins host candidates to one UDP port
// (published by compose) and the host's LAN IP — taken from STREAMIQ_LAN_URL —
// is advertised instead of the container's. srflx still gathers on ephemeral
// ports through Docker's NAT (Pion has no srflx-over-mux hook in v4).
func NewAPI() (*webrtc.API, error) {
	var se webrtc.SettingEngine
	port := os.Getenv("STREAMIQ_ICE_PORT")
	if port == "" {
		return webrtc.NewAPI(), nil
	}
	conn, err := net.ListenPacket("udp4", ":"+port)
	if err != nil {
		return nil, err
	}
	se.SetICEUDPMux(webrtc.NewICEUDPMux(nil, conn))
	if u, err := url.Parse(os.Getenv("STREAMIQ_LAN_URL")); err == nil && net.ParseIP(u.Hostname()) != nil {
		if err := se.SetICEAddressRewriteRules(webrtc.ICEAddressRewriteRule{
			External: []string{u.Hostname()}, AsCandidateType: webrtc.ICECandidateTypeHost,
		}); err != nil {
			return nil, err
		}
	}
	return webrtc.NewAPI(webrtc.WithSettingEngine(se)), nil
}

// Active counts open browser sessions (heartbeat status).
func (s *Sessions) Active() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.pcs)
}

// Handle processes one broker message; send writes JSON to the current control socket.
func (s *Sessions) Handle(raw []byte, send func(any)) {
	var m Msg
	if json.Unmarshal(raw, &m) != nil || m.Session == "" {
		return // heartbeat acks etc.: not ours
	}
	s.mu.Lock()
	if s.pcs == nil {
		s.pcs, s.keys, s.users = map[string]*webrtc.PeerConnection{}, map[string]string{}, map[string]string{}
	}
	pc := s.pcs[m.Session]
	s.mu.Unlock()

	switch m.Type {
	case "offer":
		if pc != nil || m.SDP == nil {
			return
		}
		// Every session needs a user and a role: the broker stamps both (docs/protocol.md).
		if m.User == "" || (m.Role != tunnel.Admin && m.Role != tunnel.Member) {
			log.Printf("gateway: session %s: offer without user or known role (%q) refused", m.Session, m.Role)
			return
		}
		log.Printf("gateway: session %s: user %s (%s)", m.Session, m.User, m.Role)
		pc, err := s.newPeer(m.Session, m.User, m.Role, send)
		if err != nil {
			log.Printf("gateway: session %s: %v", m.Session, err)
			return
		}
		if err := answer(pc, *m.SDP, m.Session, send); err != nil {
			log.Printf("gateway: session %s: answer: %v", m.Session, err)
			pc.Close()
		}
	case "ice":
		if pc != nil && m.Candidate != nil {
			pc.AddICECandidate(*m.Candidate)
		}
	case "bye":
		if pc != nil {
			pc.Close()
		}
	}
}

// User is the session's user id (from the broker's offer) for gateway API
// handlers; "" for an unknown session. (The offer's user also picks the Jellyfin viewer, #195;
// the role gates admin-only endpoints: tunnel.Session.Role, tunnel.AdminOnly.)
func (s *Sessions) User(session string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.users[session]
}

func (s *Sessions) newPeer(id, user, role string, send func(any)) (*webrtc.PeerConnection, error) {
	api := s.API
	if api == nil {
		api = webrtc.NewAPI()
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{
		ICEServers:   iceServers(),
		Certificates: []webrtc.Certificate{*s.Cert}, // persistent: browsers pin it
	})
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.pcs[id] = pc
	s.users[id] = user
	s.mu.Unlock()

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			init := c.ToJSON()
			send(Msg{Type: "ice", Session: id, Candidate: &init})
		}
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		log.Printf("gateway: session %s: %s", id, st)
		if st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed ||
			st == webrtc.PeerConnectionStateDisconnected {
			pc.Close()
			s.mu.Lock()
			delete(s.pcs, id)
			delete(s.keys, id)
			delete(s.users, id)
			s.mu.Unlock()
		}
	})

	var authed atomic.Bool
	pc.OnDataChannel(func(d *webrtc.DataChannel) {
		switch {
		case d.Label() == "auth":
			s.serveAuth(id, user, pc, d, &authed)
		case authed.Load():
			tunnel.Serve(d, s.Jellyfin, tunnel.Session{ID: id, User: user, Role: role, Name: func() string { return s.name(id) }})
		default:
			d.OnOpen(func() { d.Close() }) // not paired: nothing but `auth`
		}
	})
	return pc, nil
}

// authorize opens the tunnel to a paired session, after making sure its user
// has their own Jellyfin viewer, so their first request already plays as it.
func (s *Sessions) authorize(user string, authed *atomic.Bool) {
	if s.Viewers != nil {
		s.Viewers(user)
	}
	authed.Store(true)
}

// name is the session's client pairing name (allowlist entry for its key).
func (s *Sessions) name(session string) string {
	s.mu.Lock()
	fp := s.keys[session]
	s.mu.Unlock()
	for _, p := range s.Store.Paired() {
		if p.KeyFp == fp {
			return p.Name
		}
	}
	return "browser"
}

// authMsg is every message on the `auth` channel (docs/protocol.md, "Pairing").
type authMsg struct {
	Type string `json:"type"`
	N    string `json:"n,omitempty"`    // challenge / nonce / reveal
	Spki []byte `json:"spki,omitempty"` // base64 in JSON
	Sig  []byte `json:"sig,omitempty"`
	H    string `json:"h,omitempty"` // commit
	Name string `json:"name,omitempty"`
	Pair bool   `json:"pair,omitempty"`   // auth: browser has no matching pin → force the code comparison
	Why  string `json:"reason,omitempty"` // rejected
}

// serveAuth runs challenge → auth → (ok | unpaired → commit → nonce → reveal →
// approved/rejected). Messages on one channel arrive in order, one at a time.
func (s *Sessions) serveAuth(id, user string, pc *webrtc.PeerConnection, d *webrtc.DataChannel, authed *atomic.Bool) {
	say := func(m authMsg) { b, _ := json.Marshal(m); d.SendText(string(b)) }
	fail := func(why string) {
		log.Printf("gateway: auth: %s", why)
		say(authMsg{Type: "rejected", Why: why})
		d.Close()
	}
	challenge := pairing.Nonce()
	var keyFp, commit, name, nA string

	d.OnOpen(func() { say(authMsg{Type: "challenge", N: challenge}) })
	d.OnMessage(func(raw webrtc.DataChannelMessage) {
		var m authMsg
		if json.Unmarshal(raw.Data, &m) != nil {
			fail("bad message")
			return
		}
		switch {
		case m.Type == "auth" && keyFp == "":
			// The browser's DTLS cert as actually negotiated on this connection.
			browserFp := identity.Fingerprint(pc.SCTP().Transport().GetRemoteCertificate())
			fp, err := pairing.VerifyAuth(m.Spki, m.Sig, s.Fp, browserFp, challenge)
			if err != nil {
				fail(err.Error())
				return
			}
			keyFp = fp
			// Record first, then check: a concurrent Remove either sees this
			// session in Drop or has already taken the key off the allowlist.
			s.mu.Lock()
			s.keys[id] = fp
			s.mu.Unlock()
			if s.Store.Allowed(fp) && !m.Pair {
				s.authorize(user, authed)
				say(authMsg{Type: "ok"})
			} else {
				say(authMsg{Type: "unpaired"})
			}
		case m.Type == "commit" && keyFp != "" && !authed.Load() && commit == "":
			commit, name = m.H, trim(m.Name)
			nA = pairing.Nonce() // only now: the browser is committed to nB
			say(authMsg{Type: "nonce", N: nA})
		case m.Type == "reveal" && commit != "" && nA != "":
			h := sha256.Sum256([]byte(m.N))
			if hex.EncodeToString(h[:]) != commit {
				fail("reveal does not match commit")
				return
			}
			code := pairing.Code(s.Fp, keyFp, nA, m.N)
			nA = "" // one reveal per channel
			go func() {
				ok, err := s.Store.Ask(name, keyFp, code)
				switch {
				case err != nil:
					fail(err.Error())
				case !ok:
					fail("not approved")
				default:
					s.authorize(user, authed)
					say(authMsg{Type: "approved"})
				}
			}()
		default:
			fail("unexpected " + m.Type)
		}
	})
}

// Drop closes every session authed with keyFp (pairing.Store.OnRemove). Closing
// the PeerConnection ends DTLS/SCTP and every channel on it — the only kill
// that works: the tunnel is peer-to-peer, signaling isn't on the media path.
func (s *Sessions) Drop(keyFp string) {
	var victims []*webrtc.PeerConnection
	s.mu.Lock()
	for id, fp := range s.keys {
		if fp == keyFp && s.pcs[id] != nil {
			victims = append(victims, s.pcs[id])
		}
	}
	s.mu.Unlock()
	for _, pc := range victims {
		pc.Close()
	}
	if len(victims) > 0 {
		log.Printf("gateway: removed browser: closed %d session(s)", len(victims))
	}
}

func trim(name string) string {
	name = strings.TrimSpace(name)
	if len(name) > 60 {
		name = name[:60]
	}
	if name == "" {
		return "browser"
	}
	return name
}

func answer(pc *webrtc.PeerConnection, offer webrtc.SessionDescription, id string, send func(any)) error {
	if err := pc.SetRemoteDescription(offer); err != nil {
		return err
	}
	ans, err := pc.CreateAnswer(nil)
	if err != nil {
		return err
	}
	if err := pc.SetLocalDescription(ans); err != nil {
		return err
	}
	send(Msg{Type: "answer", Session: id, SDP: pc.LocalDescription()})
	return nil
}

// iceServers: Google STUN plus optional TURN from env (STREAMIQ_ICE_URLS,
// STREAMIQ_ICE_USERNAME, STREAMIQ_ICE_CREDENTIAL).
func iceServers() []webrtc.ICEServer {
	servers := []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}}
	if urls := os.Getenv("STREAMIQ_ICE_URLS"); urls != "" {
		servers = append(servers, webrtc.ICEServer{
			URLs:       strings.Split(urls, ","),
			Username:   os.Getenv("STREAMIQ_ICE_USERNAME"),
			Credential: os.Getenv("STREAMIQ_ICE_CREDENTIAL"),
		})
	}
	return servers
}
