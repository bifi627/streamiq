// Package sessions serves browsers brokered over the control socket (design:
// specs/2026-11-01-streamiq-agent-pairing-design.md, "Concurrent sessions" and
// "Connection gating"): one PeerConnection per broker session, an `auth` data
// channel that proves the browser's client key bound to this DTLS session, and
// tunnel channels only once that key is on the allowlist — or gets approved.
package sessions

import (
	"encoding/json"
	"log"
	"net"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/pion/webrtc/v4"

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

// Report is the gateway's account of a tunnel, sent once when its PeerConnection
// ends (docs/protocol.md, "Telemetry"): the broker fills that tunnel's row with it.
// local = the gateway's side of the selected pair, remote = the browser's; bytes as
// the gateway counted them on the ICE transport (sent = gateway → client).
type Report struct {
	Type                string  `json:"type"` // tunnel
	Session             string  `json:"session"`
	Relay               bool    `json:"relay"`
	Ipv6                bool    `json:"ipv6"`
	LocalCandidateType  string  `json:"localCandidateType,omitempty"`
	RemoteCandidateType string  `json:"remoteCandidateType,omitempty"`
	Protocol            string  `json:"protocol,omitempty"`
	BytesSent           uint64  `json:"bytesSent"`
	BytesReceived       uint64  `json:"bytesReceived"`
	Failure             *string `json:"failure"` // nil = the tunnel came up and passed auth
}

type Sessions struct {
	Cert  *webrtc.Certificate
	Fp    string // our DTLS fingerprint
	Store *pairing.Store
	Root  *tunnel.Root // the tunnel's root handler: gateway API + Jellyfin
	// Viewers makes sure a user has their own Jellyfin viewer (#195), once the
	// session's device is paired: an offer alone (the API) makes nothing. nil = none.
	Viewers func(user string)

	mu    sync.Mutex
	pcs   map[string]*webrtc.PeerConnection
	keys  map[string]string               // session id → client key fp, recorded before the allowlist check
	users map[string]string               // session id → user id from the offer (who acts; the key says which device)
	ends  map[string]func(iceFailed bool) // session id → its one way out: report, then close (end)
	cands map[string]*signaled            // session id → the kinds of candidate the browser signaled
	API   *webrtc.API                     // from NewAPI; nil = Pion defaults

	ctl     func(any) // the control socket that is up (RunControl's handle(nil, send)); nil = none
	backlog []Report  // tunnel reports made while none was up, sent on the next one
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
// A nil raw announces the control socket that is up (send), or that it dropped (nil send).
func (s *Sessions) Handle(raw []byte, send func(any)) {
	if raw == nil {
		s.announce(send)
		return
	}
	var m Msg
	if json.Unmarshal(raw, &m) != nil || m.Session == "" {
		return // heartbeat acks etc.: not ours
	}
	s.mu.Lock()
	if s.pcs == nil {
		s.pcs, s.keys, s.users, s.ends = map[string]*webrtc.PeerConnection{}, map[string]string{}, map[string]string{}, map[string]func(bool){}
		s.cands = map[string]*signaled{}
	}
	pc, end, cands := s.pcs[m.Session], s.ends[m.Session], s.cands[m.Session]
	s.mu.Unlock()

	switch m.Type {
	case "offer":
		s.offer(m, pc != nil, send)
	case "ice":
		if pc != nil && m.Candidate != nil {
			cands.saw(m.Candidate.Candidate)
			if err := pc.AddICECandidate(*m.Candidate); err != nil {
				log.Printf("gateway: session %s: ice: %v", m.Session, err)
			}
		}
	case "bye":
		if end != nil {
			end(false)
		}
	}
}

// announce records the control socket that is up (send), or that it dropped (nil),
// and flushes the reports held while none was.
func (s *Sessions) announce(send func(any)) {
	s.mu.Lock()
	s.ctl = send
	var backlog []Report
	if send != nil {
		backlog, s.backlog = s.backlog, nil
	}
	s.mu.Unlock()
	for _, r := range backlog {
		send(r)
	}
}

// What Handle does with an offer (checkOffer).
const (
	offerAccept = iota
	offerIgnore // a live session, or no SDP: dropped silently
	offerRefuse // no user or no known role: dropped with a log line
)

// checkOffer: every session needs a SDP, a user and a role (the broker stamps
// both, docs/protocol.md); a second offer for a live session is ignored.
func checkOffer(m Msg, live bool) int {
	switch {
	case live || m.SDP == nil:
		return offerIgnore
	case m.User == "" || (m.Role != tunnel.Admin && m.Role != tunnel.Member):
		return offerRefuse
	}
	return offerAccept
}

// offer starts a session: a new PeerConnection and its answer.
func (s *Sessions) offer(m Msg, live bool, send func(any)) {
	switch checkOffer(m, live) {
	case offerIgnore:
		return
	case offerRefuse:
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
		s.end(m.Session)
	}
}

// end ends a session the way a bye does (report, then close); no-op once ended.
func (s *Sessions) end(id string) {
	s.mu.Lock()
	end := s.ends[id]
	s.mu.Unlock()
	if end != nil {
		end(false)
	}
}

// User is the session's user id (from the broker's offer) for gateway API
// handlers; "" for an unknown session. (The offer's user also picks the Jellyfin viewer, #195;
// the role gates admin-only endpoints: tunnel.Session.Role, the route option tunnel.AdminOnly.)
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
	var authed, authSeen atomic.Bool
	var cands signaled
	var why atomic.Value // last auth outcome short of success ("unpaired", a refusal); the report's failure
	end := s.ender(id, pc, &cands, &authed, &why)
	s.mu.Lock()
	s.pcs[id] = pc
	s.users[id] = user
	s.ends[id] = end
	s.cands[id] = &cands
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
			end(st == webrtc.PeerConnectionStateFailed)
		}
	})

	slots := make(chan struct{}, tunnel.MaxChannels) // tunnel channels being served on this connection
	pc.OnDataChannel(func(d *webrtc.DataChannel) {
		switch {
		case d.Label() == "auth" && !authSeen.Swap(true): // one handshake per connection
			s.serveAuth(id, user, pc, d, &authed, &why)
		case d.Label() != "auth" && authed.Load():
			tunnel.Serve(
				d,
				s.Root,
				tunnel.Session{
					ID:    id,
					User:  user,
					Role:  role,
					Key:   s.key(id),
					Name:  func() string { return s.name(id) },
					Route: func() string { return route(pc, &cands) },
				},
				slots,
			)
		default:
			d.OnOpen(func() { d.Close() }) // not paired: nothing but `auth`; a second `auth`: never
		}
	})
	return pc, nil
}

// ender builds the session's one way out. Every way a session ends (ICE
// failed/closed, bye, a removed client, a failed answer) goes through it: the
// report is read before pc.Close() (pion's stats are gone after it) and sent
// once, whichever path comes first.
func (s *Sessions) ender(
	id string,
	pc *webrtc.PeerConnection,
	cands *signaled,
	authed *atomic.Bool,
	why *atomic.Value,
) func(iceFailed bool) {
	return func(iceFailed bool) {
		s.mu.Lock()
		_, live := s.ends[id]
		delete(s.pcs, id)
		delete(s.keys, id)
		delete(s.users, id)
		delete(s.ends, id)
		delete(s.cands, id)
		s.mu.Unlock()
		if !live {
			return
		}
		w, _ := why.Load().(string)
		s.report(report(id, pc, cands, failure(iceFailed, authed.Load(), w)))
		pc.Close()
	}
}

// failure is the tunnel report's failure: nil once authed, unless ICE failed.
func failure(iceFailed, authed bool, why string) *string {
	switch {
	case iceFailed:
		return ptr("ice failed")
	case authed:
		return nil
	case why != "":
		return &why
	}
	// Includes a browser that refused us (pin mismatch): it hangs up before auth.
	return ptr("ended before auth")
}

// authorize opens the tunnel to a paired session, after making sure its user
// has their own Jellyfin viewer, so their first request already plays as it.
func (s *Sessions) authorize(user string, authed *atomic.Bool) {
	if s.Viewers != nil {
		s.Viewers(user)
	}
	authed.Store(true)
}

// key is the client key fp the session authed with.
func (s *Sessions) key(session string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.keys[session]
}

// name is the session's client pairing name (allowlist entry for its key).
func (s *Sessions) name(session string) string {
	fp := s.key(session)
	for _, p := range s.Store.Paired() {
		if p.KeyFp == fp {
			return p.Name
		}
	}
	return "browser"
}

// Drop closes every session authed with keyFp (pairing.Store.OnRemove). Closing
// the PeerConnection ends DTLS/SCTP and every channel on it — the only kill
// that works: the tunnel is peer-to-peer, signaling isn't on the media path.
func (s *Sessions) Drop(keyFp string) {
	var victims []func(bool)
	s.mu.Lock()
	for id, fp := range s.keys {
		if fp == keyFp && s.ends[id] != nil {
			victims = append(victims, s.ends[id])
		}
	}
	s.mu.Unlock()
	for _, end := range victims {
		end(false)
	}
	if len(victims) > 0 {
		log.Printf("gateway: removed browser: closed %d session(s)", len(victims))
	}
}

// report sends r on the control socket that is up now, not the one that carried the
// offer: a tunnel often ends because that one dropped ("gateway gone"). None up = held
// for the next. ponytail: capped; a gateway that stays offline past it, or exits, loses them.
func (s *Sessions) report(r Report) {
	s.mu.Lock()
	send := s.ctl
	if send == nil && len(s.backlog) < 1000 {
		s.backlog = append(s.backlog, r)
	}
	s.mu.Unlock()
	if send != nil {
		send(r)
	}
}

// signaled records which kinds of candidate a browser trickled to us.
type signaled struct{ relay, other atomic.Bool }

func (c *signaled) saw(candidate string) {
	if _, typ, ok := strings.Cut(candidate, " typ "); ok {
		if strings.HasPrefix(typ, "relay") {
			c.relay.Store(true)
		} else {
			c.other.Store(true)
		}
	}
}

// report reads the tunnel's selected candidate pair and transport bytes from pion
// (empty pair = ICE never connected).
func report(id string, pc *webrtc.PeerConnection, cands *signaled, failure *string) Report {
	r := Report{Type: "tunnel", Session: id, Failure: failure}
	ice := pc.SCTP().Transport().ICETransport()
	if p, err := ice.GetSelectedCandidatePair(); err == nil && p != nil {
		r.LocalCandidateType, r.RemoteCandidateType = p.Local.Typ.String(), p.Remote.Typ.String()
		r.Relay, r.Ipv6 = classify(p, cands)
		r.Protocol = p.Local.Protocol.String()
	}
	st := ice.Stats()
	r.BytesSent, r.BytesReceived = st.BytesSent, st.BytesReceived
	return r
}

// classify: does the selected pair p run over a relay, and over IPv6.
func classify(p *webrtc.ICECandidatePair, cands *signaled) (relay, ipv6 bool) {
	relay = p.Local.Typ == webrtc.ICECandidateTypeRelay || p.Remote.Typ == webrtc.ICECandidateTypeRelay ||
		// The browser's relay reached us from an address it never signaled (a NAT in
		// front of the TURN server: Docker in the e2e), so pion calls it prflx. If the
		// browser offered nothing but relays (forced relay), it can only be one.
		p.Remote.Typ == webrtc.ICECandidateTypePrflx && cands.relay.Load() && !cands.other.Load()
	// A browser's host candidate may be an mDNS name: the gateway's own address decides then.
	ipv6 = strings.Contains(p.Local.Address, ":") || strings.Contains(p.Remote.Address, ":")
	return relay, ipv6
}

// route is the privacy badge's state (#428, GET /streamiq/route): relay, lan
// (the browser's address is on one of this gateway's own subnets), or direct.
// The browser can't tell lan from its own stats (mDNS names, hidden host
// candidates, stale ones); the gateway sees the real address.
func route(pc *webrtc.PeerConnection, cands *signaled) string {
	r := report("", pc, cands, nil)
	remote := ""
	if p, err := pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair(); err == nil && p != nil {
		remote = p.Remote.Address
	}
	return decide(r.Relay, remote, ownNets())
}

// decide: relay first; then lan when the browser's address is on one of nets.
// An mDNS name (Chrome hides its host address behind one) is lan as is: pion
// keeps the name after resolving it, and it only resolves over link-local
// multicast, so a selected .local candidate is on this link.
func decide(relay bool, remote string, nets []*net.IPNet) string {
	switch {
	case relay:
		return "relay"
	case strings.HasSuffix(remote, ".local") || onLink(net.ParseIP(remote), nets):
		return "lan"
	}
	return "direct"
}

// ownNets: the subnets of this machine's up interfaces, without loopback,
// point-to-point links, and interfaces without a hardware address: the
// WireGuard/Tailscale (wintun on Windows) tunnels the gateway may run, which
// would make a far-away client read as lan.
// ponytail: a TAP VPN (OpenVPN TAP, ZeroTier) has a MAC and still counts;
// read per request (the badge asks every 10 s), cache if it shows.
func ownNets() []*net.IPNet {
	var nets []*net.IPNet
	ifs, _ := net.Interfaces()
	for _, i := range ifs {
		if i.Flags&net.FlagUp == 0 || i.Flags&(net.FlagLoopback|net.FlagPointToPoint) != 0 || len(i.HardwareAddr) == 0 {
			continue
		}
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok {
				nets = append(nets, n)
			}
		}
	}
	return nets
}

// onLink: ip is inside one of nets (nil ip: no).
func onLink(ip net.IP, nets []*net.IPNet) bool {
	for _, n := range nets {
		if ip != nil && n.Contains(ip) {
			return true
		}
	}
	return false
}

func ptr(s string) *string { return &s }

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
