// Package broker is the tenant-scoped signaling broker: /api/gateways/ws (a gateway's
// control socket) and /api/broker/ws (one browser session to one gateway). It relays SDP
// and ICE but can't make either side trust the other: pins and pairing do that. It also
// writes the tunnel rows and the gateways' heartbeats and health rows.
// ponytail: its state is in memory, one API instance; Postgres LISTEN/NOTIFY or Redis
// when there's a second.
package broker

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/time/rate"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
	"streamiq/api/internal/turn"
)

type Broker struct {
	DB   *db.DB
	Auth *auth.Auth
	TURN *turn.Issuer
	// AuthTimeout is how long a browser socket may take to send its auth message.
	AuthTimeout time.Duration
	// IPHeader names the request header with the client's IP (Railway: X-Real-IP);
	// empty or missing = the connection's address. Never X-Forwarded-For: the client
	// writes its left entries.
	IPHeader string

	ips      *ipLimit
	mu       sync.Mutex
	gateways map[string]*link    // gateway id → its socket, once it sent a supported heartbeat
	sessions map[string]*session // session id → the browser
}

// New is a broker that lets each client IP open perMinute sockets a minute. A flood
// shield, loose on purpose: users behind one carrier NAT share it.
func New(d *db.DB, a *auth.Auth, t *turn.Issuer, perMinute int) *Broker {
	return &Broker{
		DB: d, Auth: a, TURN: t, AuthTimeout: 10 * time.Second,
		ips:      &ipLimit{max: perMinute, counts: map[string]int{}},
		gateways: map[string]*link{},
		sessions: map[string]*session{},
	}
}

// Routes: GET, the WebSocket handshake's method.
func (b *Broker) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/gateways/ws", b.limited(b.gateway))
	mux.HandleFunc("GET /api/broker/ws", b.limited(b.browser))
}

// link is one socket of the relay. coder/websocket allows concurrent writes, so many
// browser sessions may write to one gateway.
type link struct {
	conn           *websocket.Conn
	tenant, gateID string
}

// session is a browser's socket and the gateway link its offer went to: when that
// socket closes, the session is closed as "gateway gone". A reconnected gateway is a new link.
type session struct {
	conn *websocket.Conn
	via  *link
}

// writeTimeout bounds a send to a peer that stopped reading; coder/websocket closes it then.
const writeTimeout = 10 * time.Second

func send(conn *websocket.Conn, msg any) {
	b, err := json.Marshal(msg)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	_ = conn.Write(ctx, websocket.MessageText, b) // the other end vanished; its own loop cleans up
}

// kill closes a socket with a 1008 reason. Its reader loop then ends and cleans up.
func kill(conn *websocket.Conn, reason string) {
	_ = conn.Close(websocket.StatusPolicyViolation, reason)
}

// Revoke ends a revoked gateway's socket and every session through it.
func (b *Broker) Revoke(gatewayID string) {
	b.mu.Lock()
	g := b.gateways[gatewayID]
	delete(b.gateways, gatewayID)
	var browsers []*websocket.Conn
	for _, s := range b.sessions {
		if s.via.gateID == gatewayID {
			browsers = append(browsers, s.conn)
		}
	}
	b.mu.Unlock()
	// Sessions first: the gateway's own cleanup would close them as "gateway gone". Not
	// waiting for the peers' close handshakes (up to 5 s each).
	for _, c := range browsers {
		go kill(c, "gateway revoked")
	}
	if g != nil {
		go kill(g.conn, "revoked")
	}
}

// Fields is a message's top-level fields, each read on its own (fields.go).
type Fields = map[string]json.RawMessage

// read is the next message that is a JSON object, nil when the socket is done. A
// message over limit bytes or not an object is skipped (SDP is a few KB; 64 KB is
// generous), or with strict ends the read (the auth read: a bad first frame is
// refused). A message past lim's budget closes the socket (1008 "rate limited").
func read(ctx context.Context, conn *websocket.Conn, limit int64, lim *rate.Limiter, strict bool) Fields {
	for {
		_, r, err := conn.Reader(ctx)
		if err != nil {
			return nil
		}
		msg, err := io.ReadAll(io.LimitReader(r, limit+1))
		tooBig := int64(len(msg)) > limit
		if err == nil && tooBig {
			_, err = io.Copy(io.Discard, r) // drained, then dropped
		}
		if err != nil {
			return nil
		}
		if lim != nil && !lim.Allow() {
			kill(conn, "rate limited")
			return nil
		}
		var m Fields
		if !tooBig && json.Unmarshal(msg, &m) == nil && m != nil {
			return m
		}
		if strict {
			return nil
		}
	}
}

// accept upgrades the request. Any origin: neither socket uses cookies (the browser's
// authenticates in-band), so a foreign page gains nothing a script couldn't do itself.
// The size limit is read's, which drops a message instead of closing the socket.
func accept(w http.ResponseWriter, r *http.Request) (*websocket.Conn, error) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err == nil {
		conn.SetReadLimit(-1)
	}
	return conn, err
}

// limited answers 429 once the client's IP opened its sockets for this minute.
func (b *Broker) limited(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := strings.TrimSpace(r.Header.Get(b.IPHeader))
		if b.IPHeader == "" || ip == "" {
			ip, _, _ = net.SplitHostPort(r.RemoteAddr)
		}
		if !b.ips.allow(ip, time.Now()) {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		h(w, r)
	}
}

// ipLimit is a fixed one-minute window per IP. ponytail: one window for all IPs, reset
// whole; per-IP windows if a burst at a window's edge ever matters.
type ipLimit struct {
	mu     sync.Mutex
	max    int
	start  time.Time
	counts map[string]int
}

func (l *ipLimit) allow(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.start) >= time.Minute {
		l.start, l.counts = now, map[string]int{}
	}
	l.counts[ip]++
	return l.counts[ip] <= l.max
}
