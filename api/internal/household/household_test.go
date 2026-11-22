package household_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"streamiq/api/internal/apitest"
	"streamiq/api/internal/auth"
	"streamiq/api/internal/household"
	"streamiq/api/internal/iplimit"
)

func TestMain(m *testing.M) { os.Exit(apitest.Run(m)) }

func server(t *testing.T, ips *iplimit.Limiter) *apitest.Client {
	t.Helper()
	apitest.Reset(t)
	return apitest.Server(t, func(mux *http.ServeMux, a *auth.Auth) { household.Routes(mux, a, apitest.DB, ips) })
}

func TestCreatingAHouseholdMakesTheCallerItsAdminWithOrWithoutOneAlready(t *testing.T) {
	s := server(t, iplimit.New(100, ""))
	token := apitest.Token(t, "creator@home.test")
	user := s.User(t, token)

	first := s.Do(t, http.MethodPost, "/api/households", token, "", "")
	created := apitest.JSON[map[string]any](t, first)
	id, _ := created["householdId"].(string)
	if first.Status != http.StatusOK || len(created) != 1 || id == "" {
		t.Fatalf("%d %s", first.Status, first.Body)
	}
	if role, name := apitest.Scalar[string](t, `SELECT "Role" FROM memberships WHERE "TenantId" = $1 AND "UserId" = $2`,
		id, user), apitest.Scalar[*string](t, `SELECT "Name" FROM tenants WHERE "Id" = $1`, id); role != "admin" ||
		name != nil {
		t.Fatalf("role %s, name %v; want admin of an unnamed household", role, name)
	}
	if second := s.Do(t, http.MethodPost, "/api/households", token, "", ""); second.Status != http.StatusOK {
		t.Fatal(second.Status)
	}
	if n := apitest.Scalar[int](t, `SELECT count(*) FROM memberships WHERE "UserId" = $1 AND "Role" = 'admin'`,
		user); n != 2 {
		t.Fatalf("admin of %d households, want 2", n)
	}
	if n := apitest.Scalar[int](t, `SELECT count(*) FROM tenants`); n != 2 {
		t.Fatalf("%d households, want 2", n)
	}
}

func TestCreatingAHouseholdNeedsASignedInUser(t *testing.T) {
	s := server(t, iplimit.New(100, ""))
	if a := s.Do(t, http.MethodPost, "/api/households", "", "", ""); a.Status != http.StatusUnauthorized {
		t.Fatal(a.Status)
	}
	if n := apitest.Scalar[int](t, `SELECT count(*) FROM tenants`); n != 0 {
		t.Fatal(n)
	}
}

// New households spend the client IP's one budget, whatever else spent it.
func TestNewHouseholdsAreLimitedPerClientIP(t *testing.T) {
	ips := iplimit.New(3, "X-Real-IP")
	s := server(t, ips)
	token := apitest.Token(t, "creator@home.test")
	create := func(ip string) int {
		return s.Do(t, http.MethodPost, "/api/households", token, "", "", "X-Real-IP", ip).Status
	}
	elsewhere := spendElsewhere(ips, "203.0.113.1") // e.g. a broker socket
	got := []int{elsewhere, create("203.0.113.1"), create("203.0.113.1"), create("203.0.113.1"), create("203.0.113.2")}
	if got[0] != 200 || got[1] != 200 || got[2] != 200 || got[3] != 429 || got[4] != 200 {
		t.Fatal(got) // another IP has its own budget
	}
	if n := apitest.Scalar[int](t, `SELECT count(*) FROM tenants`); n != 3 {
		t.Fatalf("%d households, want 3", n)
	}
}

func TestOnlyAnAdminNamesTheHouseholdTrimmed(t *testing.T) {
	s := server(t, iplimit.New(100, ""))
	alice, bob := apitest.Token(t, "alice@home.test"), apitest.Token(t, "bob@home.test")
	home := apitest.Household(t, s.User(t, alice), "admin")
	apitest.Join(t, s.User(t, bob), home, "member")
	name := func() string { return apitest.Scalar[string](t, `SELECT "Name" FROM tenants WHERE "Id" = $1`, home) }

	a := s.Do(t, http.MethodPut, "/api/households/current/name", alice, "", `{"name":"  The Smiths  "}`)
	if a.Status != http.StatusOK || string(a.Body) != `{"name":"The Smiths"}` || name() != "The Smiths" {
		t.Fatalf("%d %s, stored %q", a.Status, a.Body, name())
	}
	if a := s.Do(t, http.MethodPut, "/api/households/current/name", bob, home, `{"name":"Bob's"}`); a.Status !=
		http.StatusForbidden || name() != "The Smiths" {
		t.Fatalf("member: %d, stored %q", a.Status, name())
	}
}

func TestAHouseholdNameIs1To100CharactersWithoutControlCharacters(t *testing.T) {
	s := server(t, iplimit.New(100, ""))
	alice := apitest.Token(t, "alice@home.test")
	apitest.Household(t, s.User(t, alice), "admin")
	for body, want := range map[string]int{
		`{"name":"   "}`: http.StatusBadRequest,
		`{"name":"` + strings.Repeat("a", 101) + `"}`: http.StatusBadRequest,
		`{"name":"` + strings.Repeat("😀", 51) + `"}`:  http.StatusBadRequest, // 102 UTF-16 units
		`{"name":"a\u0007b"}`:                         http.StatusBadRequest,
		`{"name":null}`:                               http.StatusBadRequest,
		`{}`:                                          http.StatusBadRequest,
		`not json`:                                    http.StatusBadRequest,
		`{"name":"` + strings.Repeat("a", 100) + `"}`:     http.StatusOK,
		`{"name":"` + strings.Repeat("😀", 50) + `"}`:      http.StatusOK,
		`{"name":"  ` + strings.Repeat("a", 100) + `  "}`: http.StatusOK,
	} {
		if a := s.Do(t, http.MethodPut, "/api/households/current/name", alice, "", body); a.Status != want {
			t.Errorf("%.40s: %d, want %d", body, a.Status, want)
		}
	}
}

// Tenant isolation: the name goes to the request's household only, and naming one the
// caller isn't in is the not-a-member 404.
func TestNamingTouchesOnlyTheRequestsHousehold(t *testing.T) {
	s := server(t, iplimit.New(100, ""))
	alice, dave := apitest.Token(t, "alice@home.test"), apitest.Token(t, "dave@home.test")
	home := apitest.Household(t, s.User(t, alice), "admin")
	cabin := apitest.Household(t, s.User(t, dave), "admin")
	apitest.Exec(t, `UPDATE tenants SET "Name" = NULL`)

	a := s.Do(t, http.MethodPut, "/api/households/current/name", alice, cabin, `{"name":"Mine now"}`)
	if a.Status != http.StatusNotFound || a.Header.Get(auth.NotMemberHeader) != "1" {
		t.Fatalf("another household: %d", a.Status)
	}
	if a := s.Do(t, http.MethodPut, "/api/households/current/name", alice, home, `{"name":"Ours"}`); a.Status !=
		http.StatusOK {
		t.Fatal(a.Status)
	}
	if n := apitest.Scalar[*string](t, `SELECT "Name" FROM tenants WHERE "Id" = $1`, cabin); n != nil {
		t.Fatalf("dave's household is named %q", *n)
	}
	if a := s.Do(t, http.MethodPut, "/api/households/current/name", apitest.Token(t, "nohome@home.test"), "",
		`{"name":"x"}`); a.Status != http.StatusNotFound || a.Header.Get(auth.NotMemberHeader) != "1" {
		t.Fatalf("no household: %d", a.Status)
	}
}

// spendElsewhere is a request from ip through another handler the limiter wraps.
func spendElsewhere(ips *iplimit.Limiter, ip string) int {
	rq := httptest.NewRequest(http.MethodGet, "/", nil)
	rq.Header.Set("X-Real-IP", ip)
	w := httptest.NewRecorder()
	ips.Wrap(func(http.ResponseWriter, *http.Request) {})(w, rq)
	return w.Code
}
