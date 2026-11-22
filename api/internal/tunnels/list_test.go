package tunnels_test

import (
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"streamiq/api/internal/apitest"
	"streamiq/api/internal/tunnels"
)

// Alice is a member of Bob's household and Bob of hers: her list in her household is
// her own rows there only, never Bob's nor her own of his household.
func TestOnlyTheCallersOwnTunnelsInTheRequestsHouseholdFromTheLast30Days(t *testing.T) {
	s := newServer(t)
	alice, bob := s.admin(t, "alice@home.test"), s.admin(t, "bob@home.test")
	apitest.Join(t, bob.id, alice.home, "member")
	apitest.Join(t, alice.id, bob.home, "member")
	nas, other := gateway(t, alice.home, "nas"), gateway(t, bob.home, "other")
	apitest.Exec(t, `UPDATE gateways SET "CredentialHash" = NULL WHERE "Id" = $1`, nas) // revoked: keeps its name
	mine := tunnel(t, alice.home, nas, alice.id, "1 hour")
	apitest.Exec(t, `UPDATE tunnels SET "Relay" = true, "Ipv6" = true, "BytesSent" = 5000, "BytesReceived" = 10,
		"ThroughputKbps" = 20000, "Failure" = 'x', "Use" = 'playback', "ActiveMs" = 4200,
		"LocalCandidateType" = 'relay', "EndedAt" = "CreatedAt" + interval '5 minutes' WHERE "Id" = $1`, mine)
	tunnel(t, alice.home, nas, alice.id, "31 days")
	tunnel(t, alice.home, nas, bob.id, "2 hours")
	tunnel(t, bob.home, other, alice.id, "3 hours")

	status, body := s.get(t, alice, alice.home, "/api/tunnels")
	rows := decode[[]map[string]any](t, body)
	if status != http.StatusOK || len(rows) != 1 {
		t.Fatal(status, body)
	}
	r := rows[0]
	want := map[string]any{"id": mine, "gatewayId": nas, "gatewayName": "nas", "relay": true, "ipv6": true,
		"bytesSent": 5000.0, "bytesReceived": 10.0, "throughputKbps": 20000.0, "failure": "x", "use": "playback",
		"activeMs": 4200.0}
	for k, v := range want {
		if r[k] != v {
			t.Errorf("%s = %v, want %v", k, r[k], v)
		}
	}
	if _, ok := r["userId"]; ok || len(r) != 13 { // no userId, no candidate types or protocol
		t.Fatal(body)
	}
	for _, k := range []string{"createdAt", "endedAt"} {
		if v, _ := r[k].(string); !strings.HasSuffix(v, "Z") {
			t.Errorf("%s = %v, want UTC with Z", k, r[k])
		}
	}
}

// The fields in .NET's order, and the ones not reported as null, not dropped.
func TestATunnelWithNothingReportedHasItsNullsInOrder(t *testing.T) {
	s := newServer(t)
	alice := s.admin(t, "alice@home.test")
	nas := gateway(t, alice.home, "nas")
	id := tunnel(t, alice.home, nas, alice.id, "1 minute")
	_, body := s.get(t, alice, "", "/api/tunnels")
	want := `","endedAt":null,"gatewayId":"` + nas + `","gatewayName":"nas","relay":false,"ipv6":false,` +
		`"bytesSent":null,"bytesReceived":null,"throughputKbps":null,"failure":null,"use":null,"activeMs":null}]`
	if !strings.HasPrefix(body, `[{"id":"`+id+`","createdAt":"`) || !strings.HasSuffix(body, want) {
		t.Fatalf("%s\nwant it to end with %s", body, want)
	}
}

func TestAtMost200NewestFirst(t *testing.T) {
	s := newServer(t)
	alice := s.admin(t, "alice@home.test")
	tunnelsAgo(t, alice.home, gateway(t, alice.home, "nas"), alice.id, tunnels.Limit+5)

	_, body := s.get(t, alice, "", "/api/tunnels")
	rows := decode[[]tunnels.Tunnel](t, body)
	if len(rows) != tunnels.Limit {
		t.Fatal(len(rows))
	}
	if !slices.IsSortedFunc(rows, func(a, b tunnels.Tunnel) int { return b.CreatedAt.Compare(a.CreatedAt) }) {
		t.Fatal("not newest first")
	}
	if time.Since(rows[len(rows)-1].CreatedAt) > (tunnels.Limit+1)*time.Minute { // the 5 oldest are the cut ones
		t.Fatal(rows[len(rows)-1].CreatedAt)
	}
}

func TestAMemberGets403ForTheHouseholdListAndTheSummaryAndAnUnknownScopeIs400(t *testing.T) {
	s := newServer(t)
	alice, bob := adminAndMember(t, s)
	for _, c := range []struct {
		u    user
		path string
		want int
	}{
		{bob, "/api/tunnels?scope=household", http.StatusForbidden},
		{bob, "/api/tunnels/summary", http.StatusForbidden},
		{alice, "/api/tunnels?scope=everything", http.StatusBadRequest},
		{bob, "/api/tunnels", http.StatusOK},
	} {
		if status, body := s.get(t, c.u, alice.home, c.path); status != c.want {
			t.Errorf("%s: %d %s, want %d", c.path, status, body, c.want)
		}
	}
}

func TestTheHouseholdListHasEveryMembersRowsWithTheirUserIDAndNoOtherHouseholds(t *testing.T) {
	s := newServer(t)
	alice, bob := adminAndMember(t, s)
	nas, other := gateway(t, alice.home, "nas"), gateway(t, bob.home, "other")
	hers := tunnel(t, alice.home, nas, alice.id, "1 hour")
	his := tunnel(t, alice.home, nas, bob.id, "2 hours")
	gone := tunnel(t, alice.home, nas, "", "3 hours")
	tunnel(t, alice.home, nas, bob.id, "31 days")
	tunnel(t, bob.home, other, bob.id, "5 minutes")

	status, body := s.get(t, alice, alice.home, "/api/tunnels?scope=household")
	rows := decode[[]tunnels.Tunnel](t, body)
	if status != http.StatusOK || len(rows) != 3 || rows[0].ID != hers || rows[1].ID != his || rows[2].ID != gone {
		t.Fatal(status, body)
	}
	if *rows[0].UserID != alice.id || *rows[1].UserID != bob.id || rows[2].UserID != nil ||
		strings.Count(body, `"userId"`) != 2 || *rows[1].GatewayName != "nas" {
		t.Fatal(body)
	}
}

// Tenant isolation: the household scope has no user filter, so only the tenant
// db.InTenant sets (RLS) keeps Carol's household out.
func TestNoListEverShowsAnotherHouseholdsRows(t *testing.T) {
	s := newServer(t)
	alice, carol := s.admin(t, "alice@home.test"), s.admin(t, "carol@home.test")
	apitest.Join(t, alice.id, carol.home, "member")
	tunnel(t, carol.home, gateway(t, carol.home, "cabin"), alice.id, "1 hour")
	for _, path := range []string{"/api/tunnels", "/api/tunnels?scope=household"} {
		if status, body := s.get(t, alice, alice.home, path); status != http.StatusOK || body != "[]" {
			t.Errorf("%s: %d %s", path, status, body)
		}
	}
}
