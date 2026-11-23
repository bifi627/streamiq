// Package broker is the tenant-scoped signaling broker: /api/gateways/ws (a gateway's
// control socket) and /api/broker/ws (one browser session to one gateway). It relays SDP
// and ICE but can't make either side trust the other: pins and pairing do that. It also
// stores the gateways' heartbeats; it keeps nothing per tunnel.
// ponytail: its state is in memory, one API instance; Postgres LISTEN/NOTIFY or Redis
// when there's a second.
package broker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/time/rate"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
	"streamiq/api/internal/iplimit"
	"streamiq/api/internal/turn"
)

type Broker struct {
	DB   *db.DB
	Auth *auth.Auth
	TURN *turn.Issuer
	// AuthTimeout is how long a browser socket may take to send its auth message.
	AuthTimeout time.Duration

	ips      *iplimit.Limiter
	stopping context.Context // cancelled by Shutdown: every socket's reads end
	stop     context.CancelFunc
	handlers sync.WaitGroup // the sockets' handlers, until their cleanup ran
	mu       sync.Mutex
	closed   bool                // Shutdown began: no new socket
	gateways map[string]*link    // gateway id → its socket, once it sent a supported heartbeat
	sessions map[string]*session // session id → the browser
}

// New is a broker whose sockets spend ips' per-client-IP budget.
func New(d *db.DB, a *auth.Auth, t *turn.Issuer, ips *iplimit.Limiter) *Broker {
	stopping, stop := context.WithCancel(context.Background())
	return &Broker{
		DB: d, Auth: a, TURN: t, AuthTimeout: 10 * time.Second,
		ips:      ips,
		stopping: stopping,
		stop:     stop,
		gateways: map[string]*link{},
		sessions: map[string]*session{},
	}
}

// Routes: GET, the WebSocket handshake's method.
func (b *Broker) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/gateways/ws", b.ips.Wrap(b.tracked(b.gateway)))
	mux.HandleFunc("GET /api/broker/ws", b.ips.Wrap(b.tracked(b.browser)))
}

// tracked runs h until Shutdown cancels its context. http.Server.Shutdown doesn't wait
// for a hijacked (WebSocket) connection, so Shutdown here does.
func (b *Broker) tracked(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		b.mu.Lock()
		if b.closed {
			b.mu.Unlock()
			http.Error(w, "shutting down", http.StatusServiceUnavailable)
			return
		}
		b.handlers.Add(1)
		b.mu.Unlock()
		defer b.handlers.Done()
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		defer context.AfterFunc(b.stopping, cancel)()
		h(w, r.WithContext(ctx))
	}
}

// Shutdown closes every socket the way a peer's close does (a tunnel's TURN credential is
// revoked) and waits for that cleanup, or until ctx is done.
func (b *Broker) Shutdown(ctx context.Context) error {
	b.mu.Lock()
	b.closed = true
	b.mu.Unlock()
	b.stop()
	done := make(chan struct{})
	go func() { b.handlers.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
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
	conn    *websocket.Conn
	via     *link
	revoked bool // Revoke closes it as "gateway revoked": the gateway's cleanup leaves it alone
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
			s.revoked = true
			browsers = append(browsers, s.conn)
		}
	}
	b.mu.Unlock()
	// Not waiting for the peers' close handshakes (up to 5 s each).
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
