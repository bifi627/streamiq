package tunnels_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"streamiq/api/internal/apitest"
	"streamiq/api/internal/auth"
	"streamiq/api/internal/tunnels"
)

func TestMain(m *testing.M) { os.Exit(apitest.Run(m)) }

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
	tunnels.Routes(mux, a, apitest.DB)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return &server{ts.URL, a}
}

type user struct{ token, id, home string }

// admin is email signed in, with a household of its own where it is the admin.
func (s *server) admin(t *testing.T, email string) user {
	t.Helper()
	token := apitest.Token(t, email)
	c, err := s.a.Token(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	return user{token, c.User, apitest.Household(t, c.User, "admin")}
}

// do is method path as u in household ("" = u's oldest): its status and body.
func (s *server) do(t *testing.T, u user, household, method, path, body string) (int, string) {
	t.Helper()
	rq, _ := http.NewRequestWithContext(t.Context(), method, s.url+path, strings.NewReader(body))
	rq.Header.Set("Authorization", "Bearer "+u.token)
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

func (s *server) get(t *testing.T, u user, household, path string) (int, string) {
	t.Helper()
	return s.do(t, u, household, http.MethodGet, path, "")
}

// bob is a member of alice's household.
func adminAndMember(t *testing.T, s *server) (alice, bob user) {
	t.Helper()
	alice, bob = s.admin(t, "alice@home.test"), s.admin(t, "bob@home.test")
	apitest.Join(t, bob.id, alice.home, "member")
	return alice, bob
}

func gateway(t *testing.T, household, name string) string {
	t.Helper()
	return apitest.Scalar[string](t, `INSERT INTO gateways ("Id", "TenantId", "Name", "CredentialHash")
		VALUES (uuidv7(), $1, $2, gen_random_uuid()::text) RETURNING "Id"::text`, household, name)
}

// tunnel adds a row of user ("" = a deleted account) through gw, age old (a Postgres interval).
func tunnel(t *testing.T, household, gw, user, age string) string {
	t.Helper()
	return apitest.Scalar[string](
		t,
		`INSERT INTO tunnels ("Id", "TenantId", "GatewayId", "UserId", "Relay", "Ipv6", "CreatedAt")
		VALUES (uuidv7(), $1, $2, nullif($3, '')::uuid, false, false, now() - $4::interval) RETURNING "Id"::text`,
		household,
		gw,
		user,
		age,
	)
}

// tunnelsAgo adds n rows of user, 1..n minutes old.
func tunnelsAgo(t *testing.T, household, gw, user string, n int) {
	t.Helper()
	apitest.Exec(t, `INSERT INTO tunnels ("Id", "TenantId", "GatewayId", "UserId", "Relay", "Ipv6", "CreatedAt")
		SELECT uuidv7(), $1, $2, $3, false, false, now() - i * interval '1 minute'
		FROM generate_series(1, $4::int) i`, household, gw, user, n)
}

func decode[T any](t *testing.T, body string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		t.Fatal(body, err)
	}
	return v
}
