package gateways_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"streamiq/api/internal/apitest"
	"streamiq/api/internal/auth"
	"streamiq/api/internal/broker"
	"streamiq/api/internal/gateways"
	"streamiq/api/internal/iplimit"
	"streamiq/api/internal/turn"
)

type server struct {
	url string
	a   *auth.Auth
}

func newServer(t *testing.T) *server {
	t.Helper()
	apitest.Reset(t)
	v, err := auth.NewVerifier(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	a := auth.New(v, apitest.DB)
	mux := http.NewServeMux()
	gateways.Routes(mux, a, apitest.DB, broker.New(apitest.DB, a, &turn.Issuer{}, iplimit.New(1000, "")))
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return &server{ts.URL, a}
}

// admin is email's token and a household of its own, where it is the admin.
func (s *server) admin(t *testing.T, email string) (token, household string) {
	t.Helper()
	token = apitest.Token(t, email)
	return token, apitest.Household(t, s.userID(t, token), "admin")
}

func (s *server) userID(t *testing.T, token string) string {
	t.Helper()
	c, err := s.a.Token(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	return c.User
}

// get is GET path as token in household ("" = the user's oldest): its status and body.
func (s *server) get(t *testing.T, token, household, path string) (int, string) {
	t.Helper()
	rq, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, s.url+path, nil)
	rq.Header.Set("Authorization", "Bearer "+token)
	if household != "" {
		rq.Header.Set(auth.HouseholdHeader, household)
	}
	rs, err := http.DefaultClient.Do(rq)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rs.Body.Close() }()
	b, _ := io.ReadAll(rs.Body)
	return rs.StatusCode, strings.TrimSpace(string(b))
}

func gateway(t *testing.T, household, name string) string {
	t.Helper()
	return apitest.Scalar[string](t, `INSERT INTO gateways ("Id", "TenantId", "Name", "CredentialHash")
		VALUES (uuidv7(), $1, $2, gen_random_uuid()::text) RETURNING "Id"::text`, household, name)
}

func names(t *testing.T, body string) string {
	t.Helper()
	var gs []gateways.Gateway
	if err := json.Unmarshal([]byte(body), &gs); err != nil {
		t.Fatal(body, err)
	}
	var out []string
	for _, g := range gs {
		out = append(out, *g.Name)
	}
	return strings.Join(out, ",")
}

// TenantIsolation.feature, ListGatewaysTests: a household sees its own gateways only.
func TestAHouseholdNeverSeesAnotherHouseholdsGateways(t *testing.T) {
	s := newServer(t)
	alice, home := s.admin(t, "alice@home.test")
	carol, cabin := s.admin(t, "carol@home.test")
	bob, _ := s.admin(t, "bob@home.test")
	gateway(t, home, "alice-nas")
	gateway(t, cabin, "carol-nas")
	for _, c := range []struct{ token, want string }{{alice, "alice-nas"}, {carol, "carol-nas"}, {bob, ""}} {
		if status, body := s.get(t, c.token, "", "/api/gateways"); status != http.StatusOK || names(t, body) != c.want {
			t.Fatalf("%d %s, want %q", status, body, c.want)
		}
	}	// A member lists them too (Households.feature: "a member still lists them").
	apitest.Join(t, s.userID(t, bob), home, "member")
	if status, body := s.get(t, bob, home, "/api/gateways"); status != http.StatusOK || names(t, body) != "alice-nas" {
		t.Fatal(status, body)
	}
}

func TestTheListIsOldestFirstWithoutRevokedOnesAndSaysOnlineAndUpgradeRequired(t *testing.T) {
	s := newServer(t)
	alice, home := s.admin(t, "alice@home.test")
	for _, n := range []string{"b-new", "a-old", "revoked"} {
		gateway(t, home, n)
	}
	apitest.Exec(t, `UPDATE gateways SET "CreatedAt" = now() - interval '1 day' WHERE "Name" = 'a-old'`)
	apitest.Exec(t, `UPDATE gateways SET "CredentialHash" = NULL WHERE "Name" = 'revoked'`)
	apitest.Exec(t, `UPDATE gateways SET "LastSeenAt" = now() - interval '89 seconds', "Protocol" = $1,
		"LanUrl" = 'http://nas.lan:8097', "Version" = '1.2.0', "Update" = '1.3.0', "Telemetry" = 'full'
		WHERE "Name" = 'a-old'`, broker.MinGatewayProtocol-1)
	apitest.Exec(t, `UPDATE gateways SET "LastSeenAt" = now() - interval '91 seconds', "Protocol" = $1
		WHERE "Name" = 'b-new'`, broker.MinGatewayProtocol)
	_, body := s.get(t, alice, "", "/api/gateways")
	var raw []map[string]any
	if err := json.Unmarshal([]byte(body), &raw); err != nil || len(raw) != 2 ||
		raw[0]["name"] != "a-old" || raw[1]["name"] != "b-new" {
		t.Fatal(body)
	}
	old, nw := raw[0], raw[1]
	if old["online"] != true || old["upgradeRequired"] != true || old["lanUrl"] != "http://nas.lan:8097" ||
		old["version"] != "1.2.0" || old["update"] != "1.3.0" || old["telemetry"] != "full" || old["lastSeenAt"] == nil {
		t.Fatal(body)
	}
	if nw["online"] != false || nw["upgradeRequired"] != false {
		t.Fatal(body)
	}
	// Never seen, no protocol: nulls (sent, not dropped), offline, no upgrade required.
	apitest.Exec(t, `UPDATE gateways SET "LastSeenAt" = NULL, "Protocol" = NULL WHERE "Name" = 'b-new'`)
	_, body = s.get(t, alice, "", "/api/gateways")
	want := `{"id":"` + nw["id"].(string) + `","name":"b-new","lastSeenAt":null,"lanUrl":null,"version":null,` +
		`"update":null,"telemetry":null,"online":false,"upgradeRequired":false}]`
	if !strings.HasSuffix(body, ","+want) {
		t.Fatalf("%s\nwant it to end with %s", body, want)
	}
}

func TestAHouseholdWithoutGatewaysGetsAnEmptyList(t *testing.T) {
	s := newServer(t)
	alice, _ := s.admin(t, "alice@home.test")
	if status, body := s.get(t, alice, "", "/api/gateways"); status != http.StatusOK || body != "[]" {
		t.Fatal(status, body)
	}
}
