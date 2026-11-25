package broker_test

import (
	"strconv"
	"testing"

	"streamiq/api/internal/apitest"
	"streamiq/protocol"
)

func gatewayCols(t *testing.T, g *gw, cols string) string {
	t.Helper()
	return apitest.Scalar[string](t, `SELECT concat_ws('|', `+cols+`) FROM gateways WHERE id = $1`, g.id)
}

// A credential the way enrollment hands it out opens the socket.
func TestAnEnrolledGatewaysCredentialOpensItsSocket(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	if !s.b.Online(nas.id) {
		t.Fatal("not registered")
	}
}

// minProtocol is what s.online's first heartbeat sends.
var minProtocol = strconv.Itoa(protocol.MinGatewayProtocol)

func TestAHeartbeatUpdatesOnlyTheSendingGatewaysRow(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	pc := s.enrolled("alice@home.test", "pc")
	s.heartbeat(nas, map[string]any{"lanUrl": "http://192.168.1.20:8097", "version": "1.4.0", "update": "1.6.0",
		"jellyfin": map[string]any{"reachable": true}, "pairedClients": 2}) // old status fields: ignored
	if got := gatewayCols(
		t,
		nas,
		`lan_url, version, update, protocol`,
	); got != "http://192.168.1.20:8097/|1.4.0|1.6.0|"+minProtocol {
		t.Fatal(got)
	}
	if got := gatewayCols(
		t,
		pc,
		`coalesce(last_seen_at::text, 'never'), coalesce(version, 'none')`,
	); got != "never|none" {
		t.Fatal(got)
	}
}

// The gateway owns its name; an older gateway sends none and changes nothing.
func TestAHeartbeatsNameRenamesTheGateway(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	for _, c := range []struct {
		sent any
		want string
	}{{"  Living room  ", "Living room"}, {"", "Living room"}, {nil, "Living room"}, {"a\u0000b", "Living room"}, {"Den", "Den"}} {
		extra := map[string]any{}
		if c.sent != nil {
			extra["name"] = c.sent
		}
		s.heartbeat(nas, extra)
		if got := gatewayCols(t, nas, `name`); got != c.want {
			t.Fatalf("%q: %q", c.sent, got)
		}
	}
}

func TestAGatewayBelowTheMinimumProtocolIsRefusedAndStoredAsSuch(t *testing.T) {
	s := newBroker(t)
	for _, p := range []any{0, nil, "1", 1.5} {
		nas := s.enrolled("alice@home.test", "nas")
		conn := s.dialGateway("Bearer " + nas.credential)
		msg := map[string]any{"type": "heartbeat", "version": "1.0.0", "name": 5}
		if p != nil {
			msg["protocol"] = p
		}
		sendJSON(t, conn, msg)
		closedAs(t, conn, "upgrade required")
		if got := gatewayCols(
			t,
			nas,
			`protocol, coalesce(last_seen_at::text, 'never')`,
		); got != "0|never" ||
			s.b.Online(nas.id) {
			t.Fatalf("%v: %s", p, got)
		}
	}
}

// An older gateway still sends its tunnel report, health and telemetry level: all
// ignored, the socket stays open and the heartbeat is stored.
func TestAnOlderGatewaysTelemetryIsIgnored(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	s.offer("alice@home.test", nas)
	sid := session(t, nas)
	sendJSON(t, nas.conn, map[string]any{"type": "tunnel", "session": sid, "bytesSent": 5, "bytesReceived": 1})
	s.heartbeat(nas, map[string]any{"version": "1.4.0", "telemetry": "full",
		"health": map[string]any{"jellyfin": map[string]any{"reachable": true}, "tunnels": 1}})
	if got := gatewayCols(t, nas, `version`); got != "1.4.0" || !s.b.Online(nas.id) {
		t.Fatal(got)
	}
}

func TestAGatewayAtTheCurrentProtocolIsAcceptedAndStaysOpen(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	if got := gatewayCols(t, nas, `protocol`); got != minProtocol || !s.b.Online(nas.id) {
		t.Fatal(got)
	}
	s.heartbeat(nas, nil) // still open
}

func TestAnAnswerBeforeTheFirstHeartbeatIsIgnored(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	browser := s.offer("alice@home.test", nas)
	sid := session(t, nas)
	late := s.dialGateway("Bearer " + nas.credential) // a reconnect that hasn't sent its heartbeat
	sendJSON(t, late, map[string]any{"type": "answer", "session": sid, "sdp": map[string]any{"sdp": "v=0"}})
	nothing(t, browser)
}
