package gateways_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"streamiq/api/internal/apitest"
	"streamiq/api/internal/gateways"
)

// healthRow is a row daysOld days old; its Tunnels column says how old, to read the order back.
func healthRow(t *testing.T, household, gateway string, daysOld int) {
	t.Helper()
	apitest.Exec(t, `INSERT INTO gateway_health (id, tenant_id, gateway_id, at, level, tunnels)
		VALUES (uuidv7(), $1, $2, now() - make_interval(days => $3), 'full', $3)`, household, gateway, daysOld)
}

func TestAnyMemberReadsTheLast7DaysLedByTheRowBeforeThem(t *testing.T) {
	s := newServer(t)
	_, home := s.admin(t, "alice@home.test")
	bob := apitest.Token(t, "bob@home.test")
	apitest.Join(t, s.userID(t, bob), home, "member")
	nas := gateway(t, home, "nas")
	for _, d := range []int{1, 10, 6, 8} {
		healthRow(t, home, nas, d)
	}
	status, body := s.get(t, bob, home, "/api/gateways/"+nas+"/health")
	var rows []gateways.HealthRow
	if err := json.Unmarshal([]byte(body), &rows); status != http.StatusOK || err != nil {
		t.Fatal(status, body)
	}
	var days []int
	for _, r := range rows {
		days = append(days, *r.Tunnels)
	}
	if len(days) != 3 || days[0] != 8 || days[1] != 6 || days[2] != 1 {
		t.Fatal(days, body)
	}
	var raw []map[string]any
	_ = json.Unmarshal([]byte(body), &raw)
	if raw[0]["jellyfinVersion"] != nil || raw[0]["cpu"] != nil || len(raw[0]) != 8 {
		t.Fatal(body) // nulls are sent, not dropped
	}
}

func TestAnotherHouseholdsGatewayOrAnUnknownOneIsNotFound(t *testing.T) {
	s := newServer(t)
	alice, home := s.admin(t, "alice@home.test")
	eve, _ := s.admin(t, "eve@home.test")
	nas := gateway(t, home, "nas")
	healthRow(t, home, nas, 1)
	for _, c := range []struct{ token, path string }{
		{eve, "/api/gateways/" + nas + "/health"},
		{alice, "/api/gateways/00000000-0000-0000-0000-000000000042/health"},
		{alice, "/api/gateways/not-a-guid/health"},
	} {
		if status, _ := s.get(t, c.token, "", c.path); status != http.StatusNotFound {
			t.Fatal(c.path, status)
		}
	}
	if status, body := s.get(t, alice, "", "/api/gateways/"+nas+"/health"); status != http.StatusOK || body == "[]" {
		t.Fatal(status, body)
	}
}

func TestAGatewayWithoutHealthRowsGetsAnEmptyList(t *testing.T) {
	s := newServer(t)
	alice, home := s.admin(t, "alice@home.test")
	nas := gateway(t, home, "nas")
	if status, body := s.get(t, alice, "", "/api/gateways/"+nas+"/health"); status != http.StatusOK || body != "[]" {
		t.Fatal(status, body)
	}
}
