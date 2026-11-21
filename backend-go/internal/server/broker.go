package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// broker is the tenant-scoped signaling state: connected gateways by gateway id, live
// browser sessions by session id. It relays SDP/ICE and can't make either side trust
// the other: pins + pairing do that.
// ponytail: in memory, one API instance; Postgres LISTEN/NOTIFY when there's a second.
type broker struct {
	mu       sync.Mutex
	gateways map[string]*link
	sessions map[string]*link
}

func newBroker() *broker {
	return &broker{gateways: map[string]*link{}, sessions: map[string]*link{}}
}

// link is one end of a relay. coder/websocket serializes concurrent writes itself
// (many browser sessions write to one gateway socket).
type link struct {
	conn            *websocket.Conn
	tenant, gateway string
	// via is a session's gateway link (the socket its offer went to): when that socket
	// closes, the session's socket is closed as "gateway gone".
	via *link
}

// A peer that stopped reading must not hold a sender forever.
const sendTimeout = 10 * time.Second

// send never fails for its caller: the other end vanishing is its own loop's business.
func (l *link) send(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), sendTimeout)
	defer cancel()
	_ = l.conn.Write(ctx, websocket.MessageText, b)
}

// kill ends the link from outside its own loop, with the reason in the close frame.
// Its reader then fails and runs its normal cleanup. Not waited for: Close gives a
// peer that never answers up to 10 s.
func (l *link) kill(reason string) {
	go func() { _ = l.conn.Close(websocket.StatusPolicyViolation, reason) }()
}

func (b *broker) gateway(id string) *link {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.gateways[id]
}

// register replaces a stale link of the same gateway (a reconnect).
func (b *broker) register(l *link) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.gateways[l.gateway] = l
}

// unregister removes l (not a newer link of the same gateway) and returns the sessions that went through it.
func (b *broker) unregister(l *link) (orphans []*link) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.gateways[l.gateway] == l {
		delete(b.gateways, l.gateway)
	}
	for _, s := range b.sessions {
		if s.via == l {
			orphans = append(orphans, s)
		}
	}
	return orphans
}

func (b *broker) open(session string, l *link) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.sessions[session] = l
}

func (b *broker) session(id string) *link {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.sessions[id]
}

// end reports whether the session was still held.
func (b *broker) end(session string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, held := b.sessions[session]
	delete(b.sessions, session)
	return held
}

// bucket is a per-socket message budget (token bucket), used by one reader only.
type bucket struct {
	tokens, burst, perSecond float64
	last                     time.Time
}

func newBucket(burst, perSecond float64) *bucket {
	return &bucket{tokens: burst, burst: burst, perSecond: perSecond, last: time.Now()}
}

func (b *bucket) allow() bool {
	now := time.Now()
	b.tokens = min(b.burst, b.tokens+now.Sub(b.last).Seconds()*b.perSecond)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

const maxMessage = 64 * 1024 // SDP is a few KB

// read returns the next JSON-object text message, false when the socket is done.
// Messages over max or not a JSON object are skipped, or with strict end the read (the
// auth read: a bad first frame is refused). A message past the limiter's budget closes
// the socket (1008 "rate limited").
// The conn's own read limit is off (SetReadLimit(-1)): it would close the socket on an
// oversized message, where the protocol drops the message and keeps the socket.
func read(ctx context.Context, conn *websocket.Conn, maxBytes int64, limiter *bucket, strict bool) ([]byte, bool) {
	for {
		_, r, err := conn.Reader(ctx)
		if err != nil {
			return nil, false
		}
		b, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
		if err != nil {
			return nil, false
		}
		tooBig := int64(len(b)) > maxBytes
		if tooBig {
			if _, err := io.Copy(io.Discard, r); err != nil {
				return nil, false
			}
		}
		if limiter != nil && !limiter.allow() {
			_ = conn.Close(websocket.StatusPolicyViolation, "rate limited")
			return nil, false
		}
		if !tooBig && json.Valid(b) && bytes.HasPrefix(bytes.TrimSpace(b), []byte("{")) {
			return b, true
		}
		if strict {
			return nil, false
		}
	}
}

// typeOf is a message's `type`; "" when it isn't a string.
func typeOf(raw []byte) string {
	var m struct {
		Type any `json:"type"`
	}
	_ = json.Unmarshal(raw, &m)
	s, _ := m.Type.(string)
	return s
}
