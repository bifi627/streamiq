package broker_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"streamiq/api/internal/turn"
)

func TestSocketsAreLimitedPerClientIP(t *testing.T) {
	s := newStack(t, nil, 2)
	status := func(path, ip string) int {
		_, rs, err := s.dial(path, http.Header{"X-Real-IP": {ip}})
		if err == nil {
			return http.StatusSwitchingProtocols
		}
		return rs.StatusCode
	}
	if got := []int{
		status("/api/broker/ws", "203.0.113.1"),
		status("/api/gateways/ws", "203.0.113.1"),
		status("/api/broker/ws", "203.0.113.1"),
		status("/api/gateways/ws", "203.0.113.1"),
		status(
			"/api/broker/ws",
			"203.0.113.2",
		),
	}; got[0] != 101 || got[1] != 401 || got[2] != 429 || got[3] != 429 || got[4] != 101 {
		t.Fatal(got) // both sockets share one budget; another IP has its own
	}
}

func TestABrowserFloodingMessagesIsClosed(t *testing.T) {
	s := newBroker(t)
	c := s.browser("flood@home.test")
	for range 100 { // the burst is 50
		if c.Write(t.Context(), websocket.MessageText, []byte(`{"type":"ice","candidate":{}}`)) != nil {
			break
		}
	}
	closedAs(t, c, "rate limited")
}

// fakeCloudflare stands in for rtc.live.cloudflare.com: a unique username per credential.
type fakeCloudflare struct {
	mu      sync.Mutex
	calls   []string
	bodies  []string
	n       int
	timeout bool
	stop    chan struct{} // ends a timing-out call, at cleanup
}

func (f *fakeCloudflare) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.calls = append(f.calls, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization"))
	body, _ := io.ReadAll(r.Body)
	f.bodies = append(f.bodies, string(body))
	f.n++
	n := f.n
	f.mu.Unlock()
	if f.timeout {
		select {
		case <-r.Context().Done():
		case <-f.stop:
		}
		return
	}
	if strings.HasSuffix(r.URL.Path, "/revoke") {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]any{"iceServers": []any{
		map[string]any{"urls": []string{"stun:stun.cloudflare.com:3478"}},
		map[string]any{
			"urls":       []string{"turn:turn.cloudflare.com:3478?transport=udp"},
			"username":   "u" + string(rune('0'+n)),
			"credential": "c",
		},
	}})
}

// minted is the bodies of the calls so far.
func (f *fakeCloudflare) minted() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.bodies...)
}

func (f *fakeCloudflare) called(call string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if c == call {
			return true
		}
	}
	return false
}

func cloudflare(t *testing.T, f *fakeCloudflare, timeout time.Duration) *turn.Issuer {
	ts := httptest.NewServer(f)
	t.Cleanup(ts.Close)
	f.stop = make(chan struct{})
	t.Cleanup(func() { close(f.stop) }) // runs before ts.Close
	return &turn.Issuer{
		KeyID:      "key1",
		Token:      "tok",
		Cloudflare: ts.URL + "/v1/turn/keys",
		HTTP:       &http.Client{Timeout: timeout},
	}
}

// ready is a browser socket of email naming gateway, and its `ready`'s ICE servers.
func ready(t *testing.T, s *stack, email, gateway string) (*websocket.Conn, []any) {
	t.Helper()
	c, m := readyMsg(t, s, email, gateway)
	servers, _ := m["iceServers"].([]any)
	return c, servers
}

// readyMsg is ready with the whole `ready` message.
func readyMsg(t *testing.T, s *stack, email, gateway string) (*websocket.Conn, map[string]any) {
	t.Helper()
	token, _ := s.user(email)
	s.household(email)
	c, _, err := s.dial("/api/broker/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	sendJSON(t, c, map[string]any{"type": "auth", "token": token, "gatewayId": gateway})
	return c, recv(t, c)
}

func TestEachBrokerSessionGetsItsOwnCloudflareCredentialRevokedWhenItEnds(t *testing.T) {
	f := &fakeCloudflare{}
	s := newStack(t, cloudflare(t, f, 5*time.Second), 1000)
	nas := s.online("turn@home.test", "nas")
	var users []string
	for range 2 {
		c, servers := ready(t, s, "turn@home.test", nas.id)
		users = append(users, servers[1].(map[string]any)["username"].(string))
		_ = c.Close(websocket.StatusNormalClosure, "")
	}
	if users[0] == users[1] || !f.called("POST /v1/turn/keys/key1/credentials/generate-ice-servers Bearer tok") {
		t.Fatal(users, f.calls)
	}
	for _, u := range users {
		waitFor(t, func() bool { return f.called("POST /v1/turn/keys/key1/credentials/" + u + "/revoke Bearer tok") })
	}
}

func TestATimedOutTURNProviderFallsBackToSTUN(t *testing.T) {
	s := newStack(t, cloudflare(t, &fakeCloudflare{timeout: true}, 200*time.Millisecond), 1000)
	_, servers := ready(t, s, "turn-down@home.test", s.online("turn-down@home.test", "nas").id)
	if len(servers) != 1 || !strings.HasPrefix(servers[0].(map[string]any)["urls"].([]any)[0].(string), "stun:") {
		t.Fatal(servers)
	}
}
