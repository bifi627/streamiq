package tunnels_test

import (
	"net/http"
	"testing"

	"streamiq/api/internal/apitest"
)

func kbps(t *testing.T, id string) *int32 {
	t.Helper()
	return apitest.Scalar[*int32](t, `SELECT "ThroughputKbps" FROM tunnels WHERE "Id" = $1`, id)
}

func TestTheBrowserAddsItsMeasuredThroughputToItsOwnTunnel(t *testing.T) {
	s := newServer(t)
	alice := s.admin(t, "alice@home.test")
	id := tunnel(t, alice.home, gateway(t, alice.home, "nas"), alice.id, "1 minute")
	patch := func(body string) int {
		t.Helper()
		status, _ := s.do(t, alice, "", http.MethodPatch, "/api/tunnels/"+id, body)
		return status
	}
	if status := patch(`{"throughputKbps":20000}`); status != http.StatusNoContent {
		t.Fatal(status)
	}
	if v := kbps(t, id); v == nil || *v != 20000 {
		t.Fatal(v)
	}
	// Missing, zero or negative stores null.
	for _, body := range []string{`{"throughputKbps":0}`, `{"throughputKbps":-5}`, `{}`, `{"throughputKbps":null}`} {
		apitest.Exec(t, `UPDATE tunnels SET "ThroughputKbps" = 1 WHERE "Id" = $1`, id)
		if status, v := patch(body), kbps(t, id); status != http.StatusNoContent || v != nil {
			t.Errorf("%s: %d %v", body, status, v)
		}
	}
	for _, body := range []string{``, `{"throughputKbps":"fast"}`, `{"throughputKbps":1.5}`} {
		if status := patch(body); status != http.StatusBadRequest {
			t.Errorf("%q: %d, want 400", body, status)
		}
	}
}

// Bob (another household) and Carol (a member of Alice's household,
// in it or in her own) get the 404 of an unknown or malformed id; nothing is stored.
func TestNobodyElseCanSetATunnelsThroughput(t *testing.T) {
	s := newServer(t)
	alice, bob, carol := s.admin(t, "alice@home.test"), s.admin(t, "bob@home.test"), s.admin(t, "carol@home.test")
	apitest.Join(t, carol.id, alice.home, "member")
	id := tunnel(t, alice.home, gateway(t, alice.home, "nas"), alice.id, "1 minute")
	for _, c := range []struct {
		u         user
		household string
		id        string
	}{
		{bob, "", id},
		{carol, alice.home, id},
		{carol, carol.home, id},
		{alice, "", "0190a8f0-0000-7000-8000-000000000000"},
		{alice, "", "not-a-uuid"},
	} {
		status, _ := s.do(t, c.u, c.household, http.MethodPatch, "/api/tunnels/"+c.id, `{"throughputKbps":1}`)
		if status != http.StatusNotFound {
			t.Errorf("%+v: %d, want 404", c, status)
		}
	}
	if v := kbps(t, id); v != nil {
		t.Fatal(*v)
	}
}

// Tenant isolation: Alice's own tunnel in Bob's household, a member of both, while her
// request acts in her own household: only the tenant (RLS) refuses it, not the user filter.
func TestAPatchNeverChangesAnotherHouseholdsTunnel(t *testing.T) {
	s := newServer(t)
	alice, bob := s.admin(t, "alice@home.test"), s.admin(t, "bob@home.test")
	apitest.Join(t, alice.id, bob.home, "member")
	id := tunnel(t, bob.home, gateway(t, bob.home, "cabin"), alice.id, "1 minute")
	status, _ := s.do(t, alice, alice.home, http.MethodPatch, "/api/tunnels/"+id, `{"throughputKbps":1}`)
	if v := kbps(t, id); status != http.StatusNotFound || v != nil {
		t.Fatal(status, "stored:", v != nil)
	}
	if status, _ := s.do(
		t,
		alice,
		bob.home,
		http.MethodPatch,
		"/api/tunnels/"+id,
		`{"throughputKbps":1}`,
	); status != http.StatusNoContent {
		t.Fatal(status) // in its own household it is hers
	}
}
