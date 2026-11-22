package broker_test

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"streamiq/api/internal/apitest"
	"streamiq/api/internal/auth"
	"streamiq/api/internal/broker"
	"streamiq/api/internal/gateways"
	"streamiq/api/internal/iplimit"
	"streamiq/api/internal/turn"
)

func TestMain(m *testing.M) { os.Exit(apitest.Run(m)) }

// stack is the broker and the revoke endpoint on a test server, over an empty database.
type stack struct {
	t          *testing.T
	url        string
	b          *broker.Broker
	auth       *auth.Auth
	households map[string]string // email → the household it made
}

func newStack(t *testing.T, issuer *turn.Issuer, perMinute int) *stack {
	t.Helper()
	apitest.Reset(t)
	v, err := auth.NewVerifier(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	a := auth.New(v, apitest.DB)
	if issuer == nil {
		issuer = &turn.Issuer{}
	}
	b := broker.New(apitest.DB, a, issuer, iplimit.New(perMinute, "X-Real-IP"))
	mux := http.NewServeMux()
	b.Routes(mux)
	gateways.Routes(mux, a, apitest.DB, b)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return &stack{t, ts.URL, b, a, map[string]string{}}
}

func newBroker(t *testing.T) *stack { return newStack(t, nil, 1000) }

// user is email's ID token and users.id.
func (s *stack) user(email string) (token, id string) {
	s.t.Helper()
	token = apitest.Token(s.t, email)
	c, err := s.auth.Token(s.t.Context(), token)
	if err != nil {
		s.t.Fatal(err)
	}
	return token, c.User
}

// household is the household email administers, made on first use.
func (s *stack) household(email string) string {
	s.t.Helper()
	if h, ok := s.households[email]; ok {
		return h
	}
	_, id := s.user(email)
	s.households[email] = apitest.Household(s.t, id, "admin")
	return s.households[email]
}

// gw is a gateway row and its open socket.
type gw struct {
	id, tenant, credential string
	conn                   *websocket.Conn
}

// enrolled adds a gateway to email's household as the .NET enrollment writes it: a
// random credential stored as its SHA-256 hex (Secrets.Hash).
func (s *stack) enrolled(email, name string) *gw {
	s.t.Helper()
	g := &gw{tenant: s.household(email), credential: rand.Text()}
	g.id = apitest.Scalar[string](
		s.t,
		`INSERT INTO gateways ("Id", "TenantId", "Name", "DtlsFingerprint", "CredentialHash")
		VALUES (uuidv7(), $1, $2, 'sha-256 AB', encode(sha256(convert_to($3, 'UTF8')), 'hex')) RETURNING "Id"::text`,
		g.tenant,
		name,
		g.credential,
	)
	return g
}

// online is an enrolled gateway whose socket sent a heartbeat the broker accepted.
func (s *stack) online(email, name string) *gw {
	s.t.Helper()
	g := s.enrolled(email, name)
	g.conn = s.dialGateway("Bearer " + g.credential)
	s.heartbeat(g, map[string]any{})
	return g
}

func (s *stack) dialGateway(authorization string) *websocket.Conn {
	s.t.Helper()
	c, _, err := s.dial("/api/gateways/ws", http.Header{"Authorization": {authorization}})
	if err != nil {
		s.t.Fatal(err)
	}
	return c
}

func (s *stack) dial(path string, h http.Header) (*websocket.Conn, *http.Response, error) {
	c, rs, err := websocket.Dial(
		s.t.Context(),
		"ws"+strings.TrimPrefix(s.url, "http")+path,
		&websocket.DialOptions{HTTPHeader: h},
	)
	if err == nil {
		c.SetReadLimit(-1)
		s.t.Cleanup(func() { _ = c.CloseNow() })
	}
	return c, rs, err
}

// heartbeat sends a heartbeat of the current protocol with extra fields and returns once
// the broker handled all of it, its health row included: the broker handles a socket's
// messages in order, so a tunnel report for a marker row sent after it is stored after.
func (s *stack) heartbeat(g *gw, extra map[string]any) {
	s.t.Helper()
	marker := apitest.Scalar[string](s.t, `INSERT INTO tunnels ("Id", "TenantId", "GatewayId", "Relay", "Ipv6")
		VALUES (uuidv7(), $1, $2, false, false) RETURNING "Id"::text`, g.tenant, g.id)
	msg := map[string]any{"type": "heartbeat", "protocol": broker.MinGatewayProtocol}
	for k, v := range extra {
		msg[k] = v
	}
	sendJSON(s.t, g.conn, msg)
	sendJSON(s.t, g.conn, map[string]any{"type": "tunnel", "session": marker, "bytesSent": 0, "bytesReceived": 0})
	waitFor(s.t, func() bool {
		return apitest.Scalar[bool](s.t, `SELECT "BytesSent" IS NOT NULL FROM tunnels WHERE "Id" = $1`, marker)
	})
	apitest.Exec(s.t, `DELETE FROM tunnels WHERE "Id" = $1`, marker)
}

// browser is a browser socket of email after `ready`; email has a household of its own.
func (s *stack) browser(email string) *websocket.Conn { return s.browserIn(email, nil) }

// browserIn is browser with the handshake's headers h.
func (s *stack) browserIn(email string, h http.Header) *websocket.Conn {
	s.t.Helper()
	s.household(email)
	token, _ := s.user(email)
	c, _, err := s.dial("/api/broker/ws", h)
	if err != nil {
		s.t.Fatal(err)
	}
	sendJSON(s.t, c, map[string]any{"type": "auth", "token": token})
	if m := recv(s.t, c); m["type"] != "ready" {
		s.t.Fatalf("not ready: %v", m)
	}
	return c
}

// offer sends an offer from a browser of email to g and returns the browser.
func (s *stack) offer(email string, g *gw) *websocket.Conn {
	s.t.Helper()
	c := s.browser(email)
	offerTo(s.t, c, g)
	return c
}

func offerTo(t *testing.T, c *websocket.Conn, g *gw) {
	t.Helper()
	sendJSON(
		t,
		c,
		map[string]any{"type": "offer", "gatewayId": g.id, "sdp": map[string]any{"type": "offer", "sdp": "v=0"}},
	)
}

// session is the session id of the offer g receives next.
func session(t *testing.T, g *gw) string {
	t.Helper()
	m := recv(t, g.conn)
	if m["type"] != "offer" {
		t.Fatalf("not an offer: %v", m)
	}
	return m["session"].(string)
}

func sendJSON(t *testing.T, c *websocket.Conn, v any) {
	t.Helper()
	b, _ := json.Marshal(v)
	if err := c.Write(t.Context(), websocket.MessageText, b); err != nil {
		t.Fatal(err)
	}
}

// recv is the next message, or fails after 5 s or on a close.
func recv(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	_, b, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("no message: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// nothing: no message within 300 ms. The read's deadline closes c, so it's the last use of c.
func nothing(t *testing.T, c *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 300*time.Millisecond)
	defer cancel()
	if _, b, err := c.Read(ctx); err == nil {
		t.Fatalf("got %s", b)
	}
}

// closed is the close frame's status and reason; fails when c gets a message first.
func closed(t *testing.T, c *websocket.Conn) (websocket.StatusCode, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	_, b, err := c.Read(ctx)
	if err == nil {
		t.Fatalf("got %s, not a close", b)
	}
	var ce websocket.CloseError
	if !errors.As(err, &ce) {
		t.Fatalf("no close frame: %v", err)
	}
	return ce.Code, ce.Reason
}

func closedAs(t *testing.T, c *websocket.Conn, reason string) {
	t.Helper()
	if code, got := closed(t, c); code != websocket.StatusPolicyViolation || got != reason {
		t.Fatalf("closed %d %q, want 1008 %q", code, got, reason)
	}
}

// waitFor polls cond for up to 5 s: the broker writes after it answers.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); !cond(); {
		if time.Now().After(end) {
			t.Fatal("timed out")
		}
		time.Sleep(20 * time.Millisecond) //nolint:forbidigo // a real socket and database: synctest can't fake them
	}
}
