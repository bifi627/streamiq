package relayusage_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"streamiq/api/internal/apitest"
	"streamiq/api/internal/auth"
	"streamiq/api/internal/relayusage"
)

func TestMain(m *testing.M) { os.Exit(apitest.Run(m)) }

type user struct{ token, id, home string }

func admin(t *testing.T, c *apitest.Client, email string) user {
	t.Helper()
	token := apitest.Token(t, email)
	id := c.User(t, token)
	return user{token, id, apitest.Household(t, id, "admin")}
}

func gateway(t *testing.T, household, name string) string {
	t.Helper()
	return apitest.Scalar[string](t, `INSERT INTO gateways (id, tenant_id, name, credential_hash)
		VALUES (uuidv7(), $1, $2, gen_random_uuid()::text) RETURNING id::text`, household, name)
}

// usage sets gateway's bytes for the UTC month monthsAgo before this one.
func usage(t *testing.T, household, gateway string, monthsAgo int, bytes int64) {
	t.Helper()
	apitest.Exec(t, `INSERT INTO relay_usage (tenant_id, gateway_id, month, bytes)
		VALUES ($1, $2, date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => $3), $4)`,
		household, gateway, monthsAgo, bytes)
}

func server(t *testing.T) *apitest.Client {
	t.Helper()
	apitest.Reset(t)
	return apitest.Server(t, func(mux *http.ServeMux, a *auth.Auth) { relayusage.Routes(mux, a, apitest.DB) })
}

func TestTheAdminSeesEachGatewaysBytesThisMonthAndLast(t *testing.T) {
	c := server(t)
	alice := admin(t, c, "alice@home.test")
	nas, old, gone := gateway(t, alice.home, "nas"), gateway(t, alice.home, "old"), uuid.NewString()
	apitest.Exec(t, `UPDATE gateways SET credential_hash = NULL WHERE id = $1`, old) // removed
	usage(t, alice.home, nas, 0, 300)
	usage(t, alice.home, nas, 1, 200)
	usage(t, alice.home, nas, 2, 999_999) // older than last month
	usage(t, alice.home, old, 1, 50)
	usage(t, alice.home, gone, 0, 7) // a gateway row that no longer exists

	a := c.Do(t, http.MethodGet, "/api/relay-usage", alice.token, alice.home, "")
	name := func(s string) *string { return &s }
	want := []relayusage.Usage{
		{GatewayID: nas, Name: name("nas"), ThisMonth: 300, LastMonth: 200},
		{GatewayID: gone, Removed: true, ThisMonth: 7},
		{GatewayID: old, Name: name("old"), Removed: true, LastMonth: 50},
	}
	if got, _ := json.Marshal(apitest.JSON[[]relayusage.Usage](t, a)); a.Status != http.StatusOK ||
		string(got) != string(must(json.Marshal(want))) {
		t.Fatalf("%d %s", a.Status, a.Body)
	}
}

func must(b []byte, err error) []byte {
	if err != nil {
		panic(err)
	}
	return b
}

// A member gets 403; an admin never sees another household's rows.
func TestOnlyTheAdminSeesItAndOnlyTheirHouseholds(t *testing.T) {
	c := server(t)
	alice, bob := admin(t, c, "alice@home.test"), admin(t, c, "bob@home.test")
	apitest.Join(t, bob.id, alice.home, "member")
	usage(t, alice.home, gateway(t, alice.home, "nas"), 0, 300)
	if a := c.Do(t, http.MethodGet, "/api/relay-usage", bob.token, alice.home, ""); a.Status != http.StatusForbidden {
		t.Fatal(a.Status, string(a.Body))
	}
	if a := c.Do(t, http.MethodGet, "/api/relay-usage", bob.token, bob.home, ""); a.Status != http.StatusOK ||
		string(a.Body) != "[]" {
		t.Fatal(a.Status, string(a.Body))
	}
}

// fakeAnalytics stands in for Cloudflare's GraphQL analytics: groups per month ("2026-11-01").
type fakeAnalytics struct {
	mu       sync.Mutex
	groups   map[string]map[string]int64
	requests []string
}

func (f *fakeAnalytics) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var rq struct {
		Query     string
		Variables struct{ Account, From, To string }
	}
	_ = json.NewDecoder(r.Body).Decode(&rq)
	f.mu.Lock()
	f.requests = append(f.requests, r.Header.Get("Authorization")+" "+rq.Variables.Account+" "+
		rq.Variables.From+".."+rq.Variables.To)
	f.mu.Unlock()
	var groups []any
	for tag, n := range f.groups[rq.Variables.From] {
		groups = append(groups, map[string]any{
			"dimensions": map[string]any{"customIdentifier": tag},
			"sum":        map[string]any{"egressBytes": n},
		})
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"viewer": map[string]any{
		"accounts": []any{map[string]any{"callsTurnUsageAdaptiveGroups": groups}},
	}}})
}

func job(t *testing.T, f *fakeAnalytics) *relayusage.Job {
	t.Helper()
	ts := httptest.NewServer(f)
	t.Cleanup(ts.Close)
	return &relayusage.Job{DB: apitest.DB, AccountID: "acc", Token: "tok", GraphQL: ts.URL, HTTP: ts.Client()}
}

func tag(t *testing.T, gateway string) string {
	t.Helper()
	return apitest.Scalar[string](t, `SELECT relay_tag FROM gateways WHERE id = $1`, gateway)
}

func bytesOf(t *testing.T, gateway, month string) int64 {
	t.Helper()
	return apitest.Scalar[int64](t, `SELECT coalesce(sum(bytes), 0)::bigint FROM relay_usage
		WHERE gateway_id = $1 AND month = $2`, gateway, month)
}

// Both months are set, never added to: a second run (a restart) doesn't double count.
func TestTheJobSetsThisMonthAndLastPerGateway(t *testing.T) {
	apitest.Reset(t)
	alice := apitest.Household(t, apitest.Scalar[string](t,
		`INSERT INTO users (id, firebase_uid) VALUES (uuidv7(), 'uid-a') RETURNING id::text`), "admin")
	nas, old := gateway(t, alice, "nas"), gateway(t, alice, "old")
	apitest.Exec(t, `UPDATE gateways SET credential_hash = NULL WHERE id = $1`, old) // removed, still counted
	apitest.Exec(t, `INSERT INTO relay_usage (tenant_id, gateway_id, month, bytes) VALUES ($1, $2, '2026-11-01', 999)`,
		alice, nas)
	f := &fakeAnalytics{groups: map[string]map[string]int64{
		"2026-11-01": {tag(t, nas): 300, "unknown-tag": 5, "": 7},
		"2026-10-01": {tag(t, nas): 200, tag(t, old): 50},
	}}
	j := job(t, f)
	now := time.Date(2026, 11, 23, 8, 0, 0, 0, time.FixedZone("UTC+5", 5*60*60))
	for range 2 {
		if err := j.Sync(t.Context(), now); err != nil {
			t.Fatal(err)
		}
	}
	if got := [3]int64{
		bytesOf(t, nas, "2026-11-01"),
		bytesOf(t, nas, "2026-10-01"),
		bytesOf(t, old, "2026-10-01"),
	}; got != [3]int64{
		300,
		200,
		50,
	} {
		t.Fatal(got)
	}
	if n := apitest.Scalar[int](t, `SELECT count(*)::int FROM relay_usage`); n != 3 {
		t.Fatal(n, "rows: an unknown tag was stored")
	}
	if strings.Join(
		f.requests[:2],
		"; ",
	) != "Bearer tok acc 2026-10-01..2026-10-31; Bearer tok acc 2026-11-01..2026-11-30" {
		t.Fatal(f.requests)
	}
}

// A full page may hide groups: the run fails instead of storing an undercount.
func TestAFullPageFailsTheRun(t *testing.T) {
	apitest.Reset(t)
	many := map[string]int64{}
	for i := range 10000 {
		many[uuid.NewString()] = int64(i)
	}
	f := &fakeAnalytics{groups: map[string]map[string]int64{"2026-10-01": many}}
	if err := job(t, f).Sync(t.Context(), time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)); err == nil ||
		!strings.Contains(err.Error(), "full page") {
		t.Fatal(err)
	}
}
