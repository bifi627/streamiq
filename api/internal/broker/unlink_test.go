package broker

import (
	"context"
	"testing"

	"github.com/coder/websocket"
)

// A gateway's socket that ends closes its sessions' browser sockets ("gateway gone"),
// except a revoked session's (Revoke closed it) and none while the broker stops: an API
// restart isn't the gateway going away, and each browser handler closes its own socket.
func TestUnlinkClosesTheGatewaysBrowsersUnlessTheBrokerStops(t *testing.T) {
	b := New(nil, nil, nil, nil)
	me, other := &link{gateID: "g1"}, &link{gateID: "g2"}
	mine, revoked := &websocket.Conn{}, &websocket.Conn{}
	b.gateways["g1"] = me
	b.sessions["s1"] = &session{conn: mine, via: me}
	b.sessions["s2"] = &session{conn: revoked, via: me, revoked: true}
	b.sessions["s3"] = &session{conn: &websocket.Conn{}, via: other}

	if dead := b.unlink(me); len(dead) != 1 || dead[0] != mine {
		t.Fatal(dead)
	}
	if b.gateways["g1"] != nil {
		t.Fatal("still linked")
	}

	b.gateways["g1"] = me
	if err := b.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if dead := b.unlink(me); dead != nil || b.gateways["g1"] != nil {
		t.Fatal(dead, b.gateways)
	}
}
