package broker_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// A stop closes every socket the way a peer's close does: the open tunnel's gateway hears its bye and
// its TURN credential is revoked before Shutdown returns; a socket after it is refused.
func TestShutdownByesTheOpenTunnelsAndRevokesTheirTURNCredentials(t *testing.T) {
	f := &fakeCloudflare{}
	s := newStack(t, cloudflare(t, f, 5*time.Second), 1000)
	nas := s.online("alice@home.test", "nas")
	browser, servers := ready(t, s, "alice@home.test", nas.id)
	offerTo(t, browser, nas)
	sid := session(t, nas)
	user := servers[1].(map[string]any)["username"].(string)

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := s.b.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if !f.called("POST /v1/turn/keys/key1/credentials/" + user + "/revoke Bearer tok") {
		t.Fatalf("calls %v", f.calls)
	}
	bye := false
	for _, c := range []*websocket.Conn{browser, nas.conn} {
		for { // the gateway hears its session's bye first
			_, b, err := c.Read(ctx)
			if err != nil {
				break
			}
			bye = bye || c == nas.conn && strings.Contains(string(b), `"bye"`) && strings.Contains(string(b), sid)
		}
	}
	if !bye {
		t.Fatal("no bye")
	}
	_, rs, err := s.dial("/api/broker/ws", nil)
	if err == nil || rs == nil || rs.StatusCode != http.StatusServiceUnavailable {
		t.Fatal(rs, err)
	}
}
