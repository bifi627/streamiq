package broker_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"streamiq/api/internal/apitest"
	"streamiq/api/internal/auth"
)

// A browser reaches gateways of households it is a member of only (checked for the
// gateway's household, never one the browser names), and a gateway can only answer
// sessions opened for it. The broker relays signaling; it never decides trust.

func refused(t *testing.T, c *websocket.Conn) {
	t.Helper()
	if m := recv(t, c); m["type"] != "error" || m["error"] != "gateway offline or unknown" {
		t.Fatalf("not refused: %v", m)
	}
}

func TestOfferReachesTheGatewayAndTheAnswerComesBack(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	_, alice := s.user("alice@home.test")
	browser := s.offer("alice@home.test", nas)
	offer := recv(t, nas.conn)
	sid, _ := offer["session"].(string)
	want := map[string]any{"type": "offer", "session": sid, "user": alice, "role": "admin",
		"sdp": map[string]any{"type": "offer", "sdp": "v=0"}}
	if b, _ := json.Marshal(offer); string(b) != string(must(json.Marshal(want))) {
		t.Fatalf("offer %s", b)
	}
	sendJSON(
		t,
		nas.conn,
		map[string]any{"type": "answer", "session": sid, "sdp": map[string]any{"type": "answer", "sdp": "v=1"}},
	)
	answer := recv(t, browser)
	if answer["type"] != "answer" || answer["tunnel"] != sid || answer["sdp"].(map[string]any)["sdp"] != "v=1" {
		t.Fatalf("answer %v", answer)
	}
}

func TestAGatewaysRefusalReachesTheBrowser(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	browser := s.offer("alice@home.test", nas)
	sid := session(t, nas)
	// Only the one known reason is relayed: the first message the browser gets is busy.
	sendJSON(t, nas.conn, map[string]any{"type": "error", "session": sid, "error": "click here: evil.test"})
	sendJSON(t, nas.conn, map[string]any{"type": "error", "session": sid, "error": "gateway busy"})
	if m := recv(t, browser); m["type"] != "error" || m["error"] != "gateway busy" || len(m) != 2 {
		t.Fatalf("browser got %v", m)
	}
}

func must(b []byte, err error) []byte {
	if err != nil {
		panic(err)
	}
	return b
}

func TestABrowserCannotReachAnotherHouseholdsGateway(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	refused(t, s.offer("bob@home.test", nas))
	nothing(t, nas.conn)
}

func TestAUserInNoHouseholdGetsNoSession(t *testing.T) {
	s := newBroker(t)
	token, _ := s.user("nobody@home.test")
	c, _, err := s.dial("/api/broker/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	sendJSON(t, c, map[string]any{"type": "auth", "token": token})
	closedAs(t, c, "no household") // before `ready`: no TURN credential either
}

func TestAMemberOfASecondHouseholdGetsTheirRoleThere(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	_, bob := s.user("bob@home.test")
	apitest.Join(t, bob, s.household("alice@home.test"), "member")
	s.offer("bob@home.test", nas)
	if m := recv(t, nas.conn); m["role"] != "member" || m["user"] != bob {
		t.Fatalf("offer %v", m)
	}
}

func TestNamingAnotherHouseholdDoesNotReachItsGateway(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	c := s.browserIn("bob@home.test", http.Header{auth.HouseholdHeader: {s.household("alice@home.test")}})
	offerTo(t, c, nas)
	refused(t, c)
	nothing(t, nas.conn)
}

func TestARemovedMembershipLosesAccessRightAway(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	_, bob := s.user("bob@home.test")
	apitest.Join(t, bob, s.household("alice@home.test"), "member")
	c := s.browser("bob@home.test") // authenticated while still a member
	apitest.Exec(
		t,
		`DELETE FROM memberships WHERE user_id = $1 AND tenant_id = $2`,
		bob,
		s.household("alice@home.test"),
	)
	offerTo(t, c, nas)
	refused(t, c)
	nothing(t, nas.conn)
}

func TestAGatewayCannotAnswerAnotherGatewaysSession(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	evil := s.online("bob@home.test", "evil")
	browser := s.offer("alice@home.test", nas)
	sid := session(t, nas)
	sendJSON(t, evil.conn, map[string]any{"type": "answer", "session": sid, "sdp": map[string]any{"sdp": "evil"}})
	sendJSON(
		t,
		evil.conn,
		map[string]any{"type": "ice", "session": sid, "candidate": map[string]any{"candidate": "evil"}},
	)
	sendJSON(t, evil.conn, map[string]any{"type": "error", "session": sid, "error": "evil"})
	nothing(t, browser)
}

func TestAGatewayThatDisconnectsEndsItsSessions(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	browser := s.offer("alice@home.test", nas)
	session(t, nas)
	_ = nas.conn.CloseNow()
	closedAs(t, browser, "gateway gone")
}

func TestABrowserWithoutAValidIDTokenIsClosed(t *testing.T) {
	s := newBroker(t)
	for _, msg := range []map[string]any{{"type": "auth", "token": "garbage"}, {"type": "auth", "token": 5}, {"type": "auth"}} {
		c, _, err := s.dial("/api/broker/ws", nil)
		if err != nil {
			t.Fatal(err)
		}
		sendJSON(t, c, msg)
		closedAs(t, c, "unauthorized")
	}
}

func TestClosingTheBrowserSocketTellsTheGateway(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	browser := s.offer("alice@home.test", nas)
	sid := session(t, nas)
	_ = browser.Close(websocket.StatusNormalClosure, "")
	if m := recv(t, nas.conn); m["type"] != "bye" || m["session"] != sid {
		t.Fatalf("not bye: %v", m)
	}
	if n := s.b.Sessions(); n != 0 {
		t.Fatalf("%d sessions held", n)
	}
}

func TestANewOfferCannotReachAGatewayThatDisconnected(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	_ = nas.conn.Close(websocket.StatusNormalClosure, "")
	waitFor(t, func() bool { return !s.b.Online(nas.id) })
	refused(t, s.offer("alice@home.test", nas))
}

func TestICECandidatesAreRelayedBothWays(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	browser := s.offer("alice@home.test", nas)
	sid := session(t, nas)
	sendJSON(t, browser, map[string]any{"type": "ice", "candidate": map[string]any{"candidate": "b"}})
	if m := recv(
		t,
		nas.conn,
	); m["type"] != "ice" || m["session"] != sid ||
		m["candidate"].(map[string]any)["candidate"] != "b" {
		t.Fatalf("gateway got %v", m)
	}
	sendJSON(t, nas.conn, map[string]any{"type": "ice", "session": sid, "candidate": map[string]any{"candidate": "g"}})
	if m := recv(t, browser); m["type"] != "ice" || m["candidate"].(map[string]any)["candidate"] != "g" {
		t.Fatalf("browser got %v", m)
	}
}

// Were the broker to keep only the tail of an oversized message, the answer would get
// through; a normal message follows, so a broker that closes instead of skipping fails too.
func TestAMessageOverTheSizeLimitIsDropped(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	browser := s.offer("alice@home.test", nas)
	sid := session(t, nas)
	answer := must(json.Marshal(map[string]any{"type": "answer", "session": sid, "sdp": map[string]any{"sdp": "v=0"}}))
	if err := nas.conn.Write(
		t.Context(),
		websocket.MessageText,
		append([]byte(strings.Repeat(" ", 64<<10)), answer...),
	); err != nil {
		t.Fatal(err)
	}
	sendJSON(t, nas.conn, map[string]any{"type": "ice", "session": sid, "candidate": map[string]any{"candidate": "g"}})
	if m := recv(t, browser); m["type"] != "ice" {
		t.Fatalf("browser got %v", m)
	}
}

// A socket that authenticated just before its gateway was revoked: the broker still holds it.
func TestARevokedGatewayWithItsSocketOpenGetsNoSessionsAndIsClosedAtItsNextHeartbeat(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	apitest.Exec(t, `UPDATE gateways SET credential_hash = NULL WHERE id = $1`, nas.id)
	if !s.b.Online(nas.id) {
		t.Fatal("not routable before the check")
	}
	refused(t, s.offer("alice@home.test", nas))
	sendJSON(t, nas.conn, map[string]any{"type": "heartbeat", "protocol": 1})
	closedAs(t, nas.conn, "revoked")
}

func TestAGatewayWithoutABearerCredentialIsRefused(t *testing.T) {
	s := newBroker(t)
	nas := s.enrolled("alice@home.test", "nas")
	for _, h := range []string{"Basic " + nas.credential, nas.credential, "Bearer" + nas.credential, "Bearer ", "Bearer garbage"} {
		if _, rs, err := s.dial("/api/gateways/ws", http.Header{"Authorization": {h}}); err == nil || rs == nil ||
			rs.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%q: %v", h, err)
		}
	}
	s.dialGateway("bearer " + nas.credential) // the scheme is case-insensitive
}

func TestABrowserThatNeverAuthenticatesIsClosedAfterTheAuthTimeout(t *testing.T) {
	s := newBroker(t)
	s.b.AuthTimeout = 300 * time.Millisecond
	c, _, err := s.dial("/api/broker/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	closedAs(t, c, "auth timeout")
	if time.Since(start) < s.b.AuthTimeout {
		t.Fatal("closed before the timeout")
	}
}

// A bad first frame is refused at once, not skipped until the timeout.
func TestABrowserWhoseFirstFrameIsNotAuthIsRefused(t *testing.T) {
	s := newBroker(t)
	token, _ := s.user("alice@home.test")
	for _, frame := range []string{`{nope`, `[1]`, `5`, `null`, `{"type":"auth","token":"` + token + `","x":"` + strings.Repeat("x", 9<<10) + `"}`,
		`{"type":"offer","token":"` + token + `"}`, `{"type":5,"token":"` + token + `"}`} {
		c, _, err := s.dial("/api/broker/ws", nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := c.Write(t.Context(), websocket.MessageText, []byte(frame)); err != nil {
			t.Fatal(err)
		}
		closedAs(t, c, "auth first")
	}
}
