package broker_test

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// A stop closes every socket the way a peer's close does: the open tunnel's TURN credential is
// revoked before Shutdown returns; a socket after it is refused.
func TestShutdownRevokesTheOpenTunnelsTURNCredentials(t *testing.T) {
	f := &fakeCloudflare{}
	s := newStack(t, cloudflare(t, f, 5*time.Second), 1000)
	nas := s.online("alice@home.test", "nas")
	browser, servers := ready(t, s, "alice@home.test", nas.id)
	offerTo(t, browser, nas)
	session(t, nas)
	user := servers[1].(map[string]any)["username"].(string)

	// Longer than every timeout on the cleanup path (the TURN client's above, writeTimeout):
	// running out means a hang, not a slow runner.
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	// Both peers read while Shutdown runs, as real ones do: a socket the gateway's cleanup
	// closes with a handshake waits up to 5 s for its peer's close frame.
	var peers sync.WaitGroup
	for _, c := range []*websocket.Conn{browser, nas.conn} {
		peers.Go(func() {
			for {
				if _, _, err := c.Read(ctx); err != nil {
					return
				}
			}
		})
	}
	if err := s.b.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if !f.called("POST /v1/turn/keys/key1/credentials/" + user + "/revoke Bearer tok") {
		t.Fatalf("calls %v", f.calls)
	}
	peers.Wait()
	if ctx.Err() != nil {
		t.Fatal("a socket is still open after Shutdown")
	}
	_, rs, err := s.dial("/api/broker/ws", nil)
	if err == nil || rs == nil || rs.StatusCode != http.StatusServiceUnavailable {
		t.Fatal(rs, err)
	}
}
