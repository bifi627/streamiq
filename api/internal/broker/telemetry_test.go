package broker_test

import (
	"testing"

	"github.com/coder/websocket"

	"streamiq/api/internal/apitest"
)

// The broker and the gateway record each tunnel, not the browser: a routed offer inserts
// the row (id = the session), the browser's socket closing stamps its end, and the
// gateway's report fills in route, bytes, failure, use and active time, only for its own
// rows.

func tunnelRow(t *testing.T, sid, cols string) string {
	t.Helper()
	return apitest.Scalar[string](t, `SELECT concat_ws('|', `+cols+`) FROM tunnels WHERE id = $1`, sid)
}

func ended(t *testing.T, sid string) bool {
	return apitest.Scalar[bool](t, `SELECT ended_at IS NOT NULL FROM tunnels WHERE id = $1`, sid)
}

func reportOf(sid string, extra map[string]any) map[string]any {
	m := map[string]any{"type": "tunnel", "session": sid, "relay": true, "ipv6": false, "bytesSent": 5000,
		"bytesReceived": 100, "localCandidateType": "relay", "remoteCandidateType": "srflx", "protocol": "udp",
		"failure": nil, "use": "playback", "activeMs": 4200}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

// waitReported: a report is stored after the broker read it, with no reply.
func waitReported(t *testing.T, sid string) {
	t.Helper()
	waitFor(t, func() bool {
		return apitest.Scalar[bool](t, `SELECT bytes_sent IS NOT NULL FROM tunnels WHERE id = $1`, sid)
	})
}

func TestARoutedOfferWritesTheTunnelRowForTheGatewaysHouseholdAndTheUser(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	_, bob := s.user("bob@home.test")
	apitest.Join(t, bob, s.household("alice@home.test"), "member")
	s.offer("bob@home.test", nas)
	sid := session(t, nas)
	want := nas.tenant + "|" + nas.id + "|" + bob + "|f|f"
	if got := tunnelRow(t, sid, `tenant_id, gateway_id, user_id, relay, ipv6`); got != want || ended(t, sid) {
		t.Fatalf("row %s, ended %v", got, ended(t, sid))
	}
}

func TestARefusedOfferWritesNoRow(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	refused(t, s.offer("bob@home.test", nas))
	if n := apitest.Scalar[int](t, `SELECT count(*) FROM tunnels`); n != 0 {
		t.Fatalf("%d rows", n)
	}
}

func TestClosingTheBrowserSocketEndsTheTunnel(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	browser := s.offer("alice@home.test", nas)
	sid := session(t, nas)
	_ = browser.Close(websocket.StatusNormalClosure, "")
	waitFor(t, func() bool { return ended(t, sid) })
}

func TestTheGatewaysReportFillsItsOwnTunnelAlsoAfterTheBrowserLeft(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	browser := s.offer("alice@home.test", nas)
	sid := session(t, nas)
	_ = browser.Close(websocket.StatusNormalClosure, "")
	waitFor(t, func() bool { return ended(t, sid) })
	sendJSON(t, nas.conn, reportOf(sid, nil))
	waitReported(t, sid)
	cols := `relay, ipv6, bytes_sent, bytes_received, local_candidate_type, remote_candidate_type, protocol,
		coalesce(failure, 'none'), use, active_ms`
	if got := tunnelRow(t, sid, cols); got != "t|f|5000|100|relay|srflx|udp|none|playback|4200" {
		t.Fatal(got)
	}
}

func TestASecondReportForTheSameTunnelIsIgnored(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	s.offer("alice@home.test", nas)
	sid := session(t, nas)
	sendJSON(t, nas.conn, reportOf(sid, nil))
	waitReported(t, sid)
	sendJSON(t, nas.conn, reportOf(sid, map[string]any{"failure": "ice failed", "bytesSent": 0}))
	s.heartbeat(nas, nil) // read after the second report: that one was handled
	if got := tunnelRow(t, sid, `bytes_sent, coalesce(failure, 'none')`); got != "5000|none" {
		t.Fatal(got)
	}
}

// Same household on purpose: row-level security would hide another household's row
// anyway, so this is what proves the gateway check itself.
func TestAGatewayCannotReportAnotherGatewaysTunnelEvenInTheSameHousehold(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	evil := s.online("alice@home.test", "evil")
	s.offer("alice@home.test", nas)
	sid := session(t, nas)
	sendJSON(t, evil.conn, reportOf(sid, nil))
	s.heartbeat(evil, nil)
	if got := tunnelRow(t, sid, `coalesce(bytes_sent::text, 'none')`); got != "none" {
		t.Fatal(got)
	}
}

func TestDeletingTheUserKeepsTheTunnelWithoutItsUser(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	s.offer("alice@home.test", nas)
	sid := session(t, nas)
	_, alice := s.user("alice@home.test")
	apitest.Exec(t, `DELETE FROM users WHERE id = $1`, alice)
	if got := tunnelRow(t, sid, `coalesce(user_id::text, 'none')`); got != "none" {
		t.Fatal(got)
	}
}

// A failed tunnel moved no bytes: its report still counts (bytes >= 0, not > 0).
func TestAFailedTunnelsReportWithZeroBytesIsRecordedWithAllItsFields(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	s.offer("alice@home.test", nas)
	sid := session(t, nas)
	sendJSON(t, nas.conn, reportOf(sid, map[string]any{"relay": false, "ipv6": true, "protocol": "tcp", "bytesSent": 0,
		"bytesReceived": 0, "failure": "ice failed", "use": nil, "activeMs": nil}))
	waitReported(t, sid)
	cols := `relay, ipv6, protocol, bytes_sent, bytes_received, failure, coalesce(use, 'none'),
		coalesce(active_ms::text, 'none')`
	if got := tunnelRow(t, sid, cols); got != "f|t|tcp|0|0|ice failed|none|none" {
		t.Fatal(got)
	}
}
