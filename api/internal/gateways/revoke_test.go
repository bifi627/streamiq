package gateways_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"streamiq/api/internal/apitest"
	"streamiq/api/internal/auth"
	"streamiq/api/internal/broker"
	"streamiq/api/internal/gateways"
	"streamiq/api/internal/iplimit"
	"streamiq/api/internal/turn"
)

func TestMain(m *testing.M) { os.Exit(apitest.Run(m)) }

// Removing a gateway over HTTP alone; what it does to the sockets is broker's revoke_test.go.
func TestOnlyAnAdminRemovesAGatewayOfTheHouseholdTheRequestActsIn(t *testing.T) {
	apitest.Reset(t)
	v, err := auth.NewVerifier(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	a := auth.New(v, apitest.DB)
	mux := http.NewServeMux()
	gateways.Routes(mux, a, apitest.DB, broker.New(apitest.DB, a, &turn.Issuer{}, iplimit.New(10, "")))
	ts := httptest.NewServer(mux)
	defer ts.Close()

	alice, bob := apitest.Token(t, "alice@home.test"), apitest.Token(t, "bob@home.test")
	id := func(token string) string {
		c, err := a.Token(t.Context(), token)
		if err != nil {
			t.Fatal(err)
		}
		return c.User
	}
	home := apitest.Household(t, id(alice), "admin")
	cabin := apitest.Household(t, id(bob), "admin")
	nas := apitest.Scalar[string](t, `INSERT INTO gateways (id, tenant_id, name, credential_hash)
		VALUES (uuidv7(), $1, 'nas', 'h') RETURNING id::text`, home)
	remove := func(token, household, gateway string) *http.Response {
		rq, _ := http.NewRequestWithContext(t.Context(), http.MethodDelete, ts.URL+"/api/gateways/"+gateway, nil)
		rq.Header.Set("Authorization", "Bearer "+token)
		if household != "" {
			rq.Header.Set(auth.HouseholdHeader, household)
		}
		rs, err := http.DefaultClient.Do(rq)
		if err != nil {
			t.Fatal(err)
		}
		_ = rs.Body.Close()
		return rs
	}
	expect := func(rs *http.Response, status int, notMember bool) {
		t.Helper()
		if rs.StatusCode != status || (rs.Header.Get(auth.NotMemberHeader) == "1") != notMember {
			t.Fatalf(
				"%s, not-member %q; want %d, %v",
				rs.Status,
				rs.Header.Get(auth.NotMemberHeader),
				status,
				notMember,
			)
		}
	}

	expect(
		remove(bob, home, nas),
		http.StatusNotFound,
		true,
	) // naming a household not theirs
	expect(
		remove(bob, cabin, nas),
		http.StatusNotFound,
		false,
	) // their own: an ordinary 404
	expect(remove(bob, cabin, "00000000-0000-0000-0000-000000000042"), http.StatusNotFound, false) // unknown
	expect(remove(bob, cabin, "not-a-guid"), http.StatusNotFound, false)
	apitest.Join(t, id(bob), home, "member")
	expect(remove(bob, home, nas), http.StatusForbidden, false)
	expect(remove(alice, "", nas), http.StatusNoContent, false)
}
