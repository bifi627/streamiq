package server

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

const refused = "gateway offline or unknown"

func wantRefused(t *testing.T, c *client) {
	t.Helper()
	if m := c.next("error"); m["error"] != refused {
		t.Fatalf("error = %v", m["error"])
	}
}

// offered sends alice's (or anyone's) offer and returns the session the gateway got.
func offered(t *testing.T, c *client, g *gateway) string {
	t.Helper()
	offerTo(c, g)
	return g.next("offer")["session"].(string)
}

// Broker.feature. Not ported: the two scenarios about DELETE /api/gateways/{id} (that
// slice is out of the spike's scope) and "an SDP the broker can't relay" (the Go broker
// relays the SDP's bytes as sent, so there is no SDP it can't relay).
func TestBroker(t *testing.T) {
	scenario := func(name string, f func(t *testing.T)) {
		t.Run(name, func(t *testing.T) { reset(t); f(t) })
	}

	scenario("An offer reaches the tenant's own gateway and the answer comes back", func(t *testing.T) {
		alice := owning(t, "alice@home.test")
		nas := onlineGateway(t, alice, "nas")
		b := browser(t, alice)
		offerTo(b, nas)
		offer := nas.next("offer")
		if offer["role"] != "admin" || offer["user"] != alice.id || offer["sdp"].(map[string]any)["sdp"] != "v=0\r\n" {
			t.Fatalf("offer = %v", offer)
		}
		nas.send(map[string]any{"type": "answer", "session": offer["session"], "sdp": map[string]any{"type": "answer", "sdp": "v=0\r\n"}, "user": "smuggled"})
		answer := b.next("answer")
		if answer["tunnel"] != offer["session"] || answer["sdp"].(map[string]any)["type"] != "answer" || len(answer) != 3 {
			t.Fatalf("answer = %v", answer)
		}
	})

	scenario("A browser cannot reach another tenant's gateway", func(t *testing.T) {
		nas := onlineGateway(t, owning(t, "alice@home.test"), "nas")
		b := browser(t, owning(t, "bob@home.test"))
		offerTo(b, nas)
		wantRefused(t, b)
		nas.nothing()
	})

	scenario("A user in no household gets no session and no TURN credential", func(t *testing.T) {
		c, _, err := dial(t, "/api/broker/ws")
		if err != nil {
			t.Fatal(err)
		}
		c.send(map[string]any{"type": "auth", "token": signIn(t, "nobody@home.test").token})
		if why := c.closedAs(); why != "no household" {
			t.Fatalf("closed as %q", why)
		}
	})

	scenario("A member of a second household reaches that household's gateway, with their role there", func(t *testing.T) {
		alice, bob := owning(t, "alice@home.test"), owning(t, "bob@home.test")
		nas := onlineGateway(t, alice, "nas")
		join(t, bob, alice.household, "member")
		offerTo(browser(t, bob), nas)
		if offer := nas.next("offer"); offer["role"] != "member" || offer["user"] != bob.id {
			t.Fatalf("offer = %v", offer)
		}
	})

	scenario("Naming another household does not let a browser reach its gateway", func(t *testing.T) {
		alice := owning(t, "alice@home.test")
		nas := onlineGateway(t, alice, "nas")
		b := browser(t, owning(t, "bob@home.test"), householdHeader, alice.household)
		b.send(map[string]any{"type": "offer", "gatewayId": nas.id, "sdp": sdp, "household": alice.household, "tenantId": alice.household})
		wantRefused(t, b)
		nas.nothing()
	})

	scenario("A removed membership loses broker access right away", func(t *testing.T) {
		alice, bob := owning(t, "alice@home.test"), owning(t, "bob@home.test")
		nas := onlineGateway(t, alice, "nas")
		join(t, bob, alice.household, "member")
		b := browser(t, bob) // authenticated while still a member
		exec1(t, `DELETE FROM memberships WHERE "TenantId" = $1 AND "UserId" = $2`, alice.household, bob.id)
		offerTo(b, nas)
		wantRefused(t, b)
		nas.nothing()
	})

	scenario("A gateway cannot answer another gateway's session, even knowing its id", func(t *testing.T) {
		alice := owning(t, "alice@home.test")
		nas, evil := onlineGateway(t, alice, "nas"), onlineGateway(t, owning(t, "bob@home.test"), "evil")
		b := browser(t, alice)
		session := offered(t, b, nas)
		evil.send(map[string]any{"type": "answer", "session": session, "sdp": sdp})
		evil.send(map[string]any{"type": "ice", "session": session, "candidate": map[string]any{"candidate": "x"}})
		b.nothing()
	})

	scenario("A gateway that disconnects ends its sessions right away", func(t *testing.T) {
		alice := owning(t, "alice@home.test")
		nas := onlineGateway(t, alice, "nas")
		b := browser(t, alice)
		offered(t, b, nas)
		_ = nas.conn.CloseNow()
		if why := b.closedAs(); why != "gateway gone" {
			t.Fatalf("closed as %q", why)
		}
	})

	scenario("A browser socket without a valid ID token is closed", func(t *testing.T) {
		c, _, _ := dial(t, "/api/broker/ws")
		c.send(map[string]any{"type": "auth", "token": "garbage"})
		if why := c.closedAs(); why != "unauthorized" {
			t.Fatalf("closed as %q", why)
		}
	})

	scenario("Closing the browser socket tells the gateway and ends the session", func(t *testing.T) {
		alice := owning(t, "alice@home.test")
		nas := onlineGateway(t, alice, "nas")
		b := browser(t, alice)
		session := offered(t, b, nas)
		_ = b.conn.CloseNow()
		if bye := nas.next("bye"); bye["session"] != session {
			t.Fatalf("bye = %v", bye)
		}
		if srv.broker.session(session) != nil {
			t.Fatal("the broker still holds the session")
		}
	})

	scenario("A new offer cannot reach a gateway that disconnected", func(t *testing.T) {
		alice := owning(t, "alice@home.test")
		nas := onlineGateway(t, alice, "nas")
		_ = nas.conn.CloseNow()
		if eventually(5*time.Second, func() error {
			if srv.broker.gateway(nas.id) != nil {
				return http.ErrBodyNotAllowed
			}
			return nil
		}) != nil {
			t.Fatal("the broker still lists the gateway")
		}
		b := browser(t, alice)
		offerTo(b, nas)
		wantRefused(t, b)
	})

	scenario("ICE candidates are relayed both ways", func(t *testing.T) {
		alice := owning(t, "alice@home.test")
		nas := onlineGateway(t, alice, "nas")
		b := browser(t, alice)
		session := offered(t, b, nas)
		candidate := map[string]any{"candidate": "candidate:1 1 udp 1 192.0.2.1 9 typ host", "sdpMid": "0", "sdpMLineIndex": 0.0, "usernameFragment": "abcd"}
		b.send(map[string]any{"type": "ice", "candidate": candidate})
		got := nas.next("ice")
		if got["session"] != session || got["candidate"].(map[string]any)["usernameFragment"] != "abcd" {
			t.Fatalf("gateway got %v", got)
		}
		nas.send(map[string]any{"type": "ice", "session": session, "candidate": candidate})
		if got := b.next("ice"); got["candidate"].(map[string]any)["sdpMid"] != "0" || got["session"] != nil {
			t.Fatalf("browser got %v", got)
		}
	})

	scenario("A message over the size limit is dropped", func(t *testing.T) {
		alice := owning(t, "alice@home.test")
		nas := onlineGateway(t, alice, "nas")
		b := browser(t, alice)
		session := offered(t, b, nas)
		nas.send(map[string]any{"type": "answer", "session": session, "sdp": map[string]any{"type": "answer", "sdp": strings.Repeat("x", 70_000)}})
		nas.send(map[string]any{"type": "ice", "session": session, "candidate": map[string]any{"candidate": "after"}})
		b.next("ice") // not the answer, and the socket is still up
	})

	scenario("A gateway revoked while its socket stays open gets no new sessions and is closed at its next heartbeat", func(t *testing.T) {
		alice := owning(t, "alice@home.test")
		nas := onlineGateway(t, alice, "nas")
		exec1(t, `UPDATE gateways SET "CredentialHash" = NULL WHERE "Id" = $1`, nas.id)
		b := browser(t, alice)
		offerTo(b, nas)
		wantRefused(t, b)
		nas.send(heartbeat())
		if why := nas.closedAs(); why != "revoked" {
			t.Fatalf("closed as %q", why)
		}
	})

	scenario("A gateway whose Authorization header is not a Bearer credential is refused", func(t *testing.T) {
		nas := onlineGateway(t, owning(t, "alice@home.test"), "nas")
		for _, header := range []string{"Basic " + nas.credential, nas.credential, "Bearer" + nas.credential, "Bearer wrong", ""} {
			if _, rs, err := dial(t, "/api/gateways/ws", "Authorization", header); err == nil || rs == nil || rs.StatusCode != http.StatusUnauthorized {
				t.Fatalf("Authorization %q: %v", header, err)
			}
		}
	})

	scenario("A gateway below the minimum protocol is refused as upgrade required, and recorded", func(t *testing.T) {
		alice := owning(t, "alice@home.test")
		nas := onlineGateway(t, alice, "nas")
		old, _, _ := dial(t, "/api/gateways/ws", "Authorization", "Bearer "+nas.credential)
		old.send(map[string]any{"type": "heartbeat", "name": 7, "lanUrl": false}) // no protocol, wrong types
		if why := old.closedAs(); why != "upgrade required" {
			t.Fatalf("closed as %q", why)
		}
		if list := listGateways(t, alice); len(list) != 1 || !list[0].UpgradeRequired {
			t.Fatalf("gateways = %+v", list)
		}
	})

	scenario("A browser socket that never authenticates is closed after the auth timeout", func(t *testing.T) {
		c, _, _ := dial(t, "/api/broker/ws")
		start := time.Now()
		if why := c.closedAs(); why != "auth timeout" || time.Since(start) < srv.cfg.AuthTimeout {
			t.Fatalf("closed as %q after %s", why, time.Since(start))
		}
	})

	scenario("A browser socket whose first frame is not a JSON object, or not auth, is refused", func(t *testing.T) {
		for name, frame := range map[string][]byte{
			"invalid JSON":  []byte("{nope"),
			"a JSON array":  []byte("[1]"),
			"a JSON number": []byte("7"),
			"a 9 KB frame":  []byte(`{"type":"auth","token":"` + strings.Repeat("x", 9000) + `"}`),
			"an offer":      []byte(`{"type":"offer","gatewayId":"x"}`),
		} {
			c, _, _ := dial(t, "/api/broker/ws")
			c.send(frame)
			if why := c.closedAs(); why != "auth first" {
				t.Fatalf("%s: closed as %q", name, why)
			}
		}
	})

	scenario("A socket past its message budget is closed as rate limited", func(t *testing.T) {
		b := browser(t, owning(t, "alice@home.test"))
		for range 80 { // the browser's budget: a burst of 50, then 10 a second
			_ = b.conn.Write(t.Context(), 1, []byte(`{"type":"ice"}`))
		}
		if why := b.closedAs(); why != "rate limited" {
			t.Fatalf("closed as %q", why)
		}
	})
}

type tunnelRow struct {
	Tenant, Gateway                             string
	User, Failure, Use, Local, Remote, Protocol *string
	Sent, Received, ActiveMs                    *int64
	Kbps                                        *int
	Relay, Ipv6, Ended                          bool
}

func tunnel(t *testing.T, session string) (r tunnelRow) {
	t.Helper()
	err := owner.QueryRow(t.Context(), `
		SELECT "TenantId", "GatewayId", "UserId", "Failure", "Use", "LocalCandidateType", "RemoteCandidateType", "Protocol",
		       "BytesSent", "BytesReceived", "ActiveMs", "ThroughputKbps", "Relay", "Ipv6", "EndedAt" IS NOT NULL
		FROM tunnels WHERE "Id" = $1`, session).
		Scan(&r.Tenant, &r.Gateway, &r.User, &r.Failure, &r.Use, &r.Local, &r.Remote, &r.Protocol, &r.Sent, &r.Received, &r.ActiveMs, &r.Kbps, &r.Relay, &r.Ipv6, &r.Ended)
	if err != nil {
		t.Fatalf("tunnel %s: %v", session, err)
	}
	return r
}

// until waits for the broker to have written what a test just caused.
func until(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); !ok(); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(end) {
			t.Fatalf("never: %s", what)
		}
	}
}

func relayedReport(session string) map[string]any {
	return map[string]any{"type": "tunnel", "session": session, "relay": true, "bytesSent": 5000, "bytesReceived": 100,
		"localCandidateType": "relay", "remoteCandidateType": "srflx", "protocol": "udp", "failure": nil, "use": "playback", "activeMs": 4200}
}

// Tunnels/TunnelTelemetry.feature
func TestTunnelTelemetry(t *testing.T) {
	scenario := func(name string, f func(t *testing.T)) {
		t.Run(name, func(t *testing.T) { reset(t); f(t) })
	}
	// alice's household with gateway "nas", and a browser of hers with a routed offer.
	routed := func(t *testing.T) (alice *user, nas *gateway, b *client, session string) {
		alice = owning(t, "alice@home.test")
		nas = onlineGateway(t, alice, "nas")
		b = browser(t, alice)
		return alice, nas, b, offered(t, b, nas)
	}

	scenario("A routed offer writes the tunnel row for the gateway's household and the user", func(t *testing.T) {
		alice, bob := owning(t, "alice@home.test"), owning(t, "bob@home.test")
		nas := onlineGateway(t, alice, "nas")
		join(t, bob, alice.household, "member")
		row := tunnel(t, offered(t, browser(t, bob), nas))
		if row.Tenant != alice.household || row.Gateway != nas.id || *row.User != bob.id || row.Ended || row.Sent != nil {
			t.Fatalf("row = %+v", row)
		}
	})

	scenario("A refused offer writes no row", func(t *testing.T) {
		nas := onlineGateway(t, owning(t, "alice@home.test"), "nas")
		b := browser(t, owning(t, "bob@home.test"))
		offerTo(b, nas)
		wantRefused(t, b)
		if n := scalar[int](t, `SELECT count(*) FROM tunnels`); n != 0 {
			t.Fatalf("%d tunnels stored", n)
		}
	})

	scenario("The gateway's report fills its own tunnel, also after the browser left", func(t *testing.T) {
		_, nas, b, session := routed(t)
		_ = b.conn.CloseNow()
		until(t, "the tunnel gets an end time", func() bool { return tunnel(t, session).Ended })
		nas.next("bye")
		nas.send(relayedReport(session))
		until(t, "the report is stored", func() bool { return tunnel(t, session).Sent != nil })
		row := tunnel(t, session)
		if !row.Relay || *row.Sent != 5000 || row.Failure != nil || *row.Use != "playback" || *row.ActiveMs != 4200 || *row.Local != "relay" {
			t.Fatalf("row = %+v", row)
		}
	})

	scenario("A second report for the same tunnel is ignored", func(t *testing.T) {
		_, nas, _, session := routed(t)
		nas.send(relayedReport(session))
		nas.send(map[string]any{"type": "tunnel", "session": session, "bytesSent": 0, "bytesReceived": 0, "failure": "ice failed"})
		nas.send(heartbeat()) // in order on one socket: once this is stored, both reports were handled
		before := time.Now()
		until(t, "the heartbeat after the reports is stored", func() bool {
			return scalar[time.Time](t, `SELECT "LastSeenAt" FROM gateways WHERE "Id" = $1`, nas.id).After(before.Add(-time.Second)) && tunnel(t, session).Sent != nil
		})
		if row := tunnel(t, session); !row.Relay || *row.Sent != 5000 || row.Failure != nil {
			t.Fatalf("row = %+v", row)
		}
	})

	// Same household on purpose: RLS would hide another household's row anyway, so this
	// is what proves the gateway check itself.
	scenario("A gateway cannot report another gateway's tunnel, even in the same household", func(t *testing.T) {
		alice, nas, _, session := routed(t)
		evil := onlineGateway(t, alice, "evil")
		evil.send(relayedReport(session))
		evil.send(map[string]any{"type": "tunnel", "session": "probe", "bytesSent": 1, "bytesReceived": 1})
		nas.nothing()
		if row := tunnel(t, session); row.Sent != nil || row.Relay {
			t.Fatalf("row = %+v", row)
		}
	})

	scenario("The browser adds its measured throughput to its own tunnel", func(t *testing.T) {
		alice, _, _, session := routed(t)
		if rs := request(t, "PATCH", "/api/tunnels/"+session, alice.token, map[string]int{"throughputKbps": 20000}); rs.StatusCode != http.StatusNoContent {
			t.Fatalf("status = %s", rs.Status)
		}
		if row := tunnel(t, session); *row.Kbps != 20000 {
			t.Fatalf("row = %+v", row)
		}
	})

	scenario("Nobody else can set a tunnel's throughput", func(t *testing.T) {
		alice, _, _, session := routed(t)
		bob, carol := owning(t, "bob@home.test"), signIn(t, "carol@home.test")
		join(t, carol, alice.household, "member")
		body := map[string]int{"throughputKbps": 1}
		for who, rs := range map[string]*http.Response{
			"bob, another household":                request(t, "PATCH", "/api/tunnels/"+session, bob.token, body),
			"bob, naming alice's household":         request(t, "PATCH", "/api/tunnels/"+session, bob.token, body, householdHeader, alice.household),
			"carol, a member of the same household": request(t, "PATCH", "/api/tunnels/"+session, carol.token, body, householdHeader, alice.household),
			"alice, an id that is not a uuid":       request(t, "PATCH", "/api/tunnels/nope", alice.token, body),
		} {
			if rs.StatusCode != http.StatusNotFound {
				t.Fatalf("%s: %s", who, rs.Status)
			}
		}
		if row := tunnel(t, session); row.Kbps != nil {
			t.Fatalf("row = %+v", row)
		}
	})

	scenario("Deleting the user keeps the tunnel, without its user", func(t *testing.T) {
		alice, _, _, session := routed(t)
		exec1(t, `DELETE FROM users WHERE "Id" = $1`, alice.id)
		if row := tunnel(t, session); row.User != nil {
			t.Fatalf("row = %+v", row)
		}
	})

	scenario("A failed tunnel's report with 0 bytes is recorded with all its fields", func(t *testing.T) {
		_, nas, _, session := routed(t)
		nas.send(map[string]any{"type": "tunnel", "session": session, "relay": false, "ipv6": true, "bytesSent": 0, "bytesReceived": 0,
			"localCandidateType": "host", "remoteCandidateType": "host", "protocol": "tcp", "failure": "ice failed"})
		until(t, "the report is stored", func() bool { return tunnel(t, session).Sent != nil })
		row := tunnel(t, session)
		if *row.Failure != "ice failed" || !row.Ipv6 || *row.Protocol != "tcp" || *row.Sent != 0 || row.Use != nil || row.ActiveMs != nil {
			t.Fatalf("row = %+v", row)
		}
	})

	scenario("A full heartbeat stores one health row for the gateway's household", func(t *testing.T) {
		alice, nas, _, _ := routed(t)
		full := heartbeat()
		full["telemetry"] = "full"
		full["health"] = map[string]any{"jellyfin": map[string]any{"reachable": true, "version": "12.4"}, "os": "linux", "arch": "arm64",
			"transcoding": "none", "tunnels": 1, "cpu": 250.0, "memory": 41.5}
		nas.send(full)
		nas.send(full) // within the minimum gap: no second row
		until(t, "the gateway reads as full", func() bool {
			return scalar[*string](t, `SELECT "Telemetry" FROM gateways WHERE "Id" = $1`, nas.id) != nil && *listGateways(t, alice)[0].Telemetry == "full"
		})
		nas.send(heartbeat())
		until(t, "the gateway reads as off again", func() bool { return *listGateways(t, alice)[0].Telemetry == "off" })
		var n int
		var cpu, memory *float64
		var tenant string
		if err := owner.QueryRow(t.Context(), `SELECT count(*), min("Cpu"), min("Memory"), min("TenantId"::text) FROM gateway_health WHERE "GatewayId" = $1`, nas.id).
			Scan(&n, &cpu, &memory, &tenant); err != nil || n != 1 || cpu != nil || *memory != 41.5 || tenant != alice.household {
			t.Fatalf("%d health rows, cpu %v, memory %v, tenant %s, %v", n, cpu, memory, tenant, err)
		}
	})
}
