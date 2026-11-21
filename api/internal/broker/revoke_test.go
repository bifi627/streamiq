package broker_test

import (
	"net/http"
	"testing"

	"streamiq/api/internal/apitest"
)

// DELETE /api/gateways/{id} (the gateways slice) as the broker sees it.
func (s *stack) remove(email string, g *gw) int {
	s.t.Helper()
	token, _ := s.user(email)
	rq, _ := http.NewRequestWithContext(s.t.Context(), http.MethodDelete, s.url+"/api/gateways/"+g.id, nil)
	rq.Header.Set("Authorization", "Bearer "+token)
	rs, err := http.DefaultClient.Do(rq)
	if err != nil {
		s.t.Fatal(err)
	}
	_ = rs.Body.Close()
	return rs.StatusCode
}

func TestRemovingAGatewayRevokesItsCredentialAndEndsItsSessions(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	browser := s.offer("alice@home.test", nas)
	session(t, nas)
	if got := s.remove("alice@home.test", nas); got != http.StatusNoContent {
		t.Fatal(got)
	}
	closedAs(t, nas.conn, "revoked")
	closedAs(t, browser, "gateway revoked")
	if _, rs, err := s.dial(
		"/api/gateways/ws",
		http.Header{"Authorization": {"Bearer " + nas.credential}},
	); err == nil ||
		rs.StatusCode != http.StatusUnauthorized {
		t.Fatal("the credential still works")
	}
	if apitest.Scalar[bool](t, `SELECT "CredentialHash" IS NOT NULL FROM gateways WHERE "Id" = $1`, nas.id) {
		t.Fatal("not revoked")
	}
	if got := s.remove("alice@home.test", nas); got != http.StatusNotFound {
		t.Fatalf("second removal: %d", got)
	}
}

func TestAHouseholdCannotRemoveAnotherHouseholdsGateway(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	s.household("bob@home.test")
	if got := s.remove("bob@home.test", nas); got != http.StatusNotFound {
		t.Fatal(got)
	}
	s.offer("alice@home.test", nas)
	session(t, nas)
}

func TestAMemberCannotRemoveAGateway(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	_, bob := s.user("bob@home.test")
	apitest.Join(t, bob, s.household("alice@home.test"), "member")
	rq, _ := http.NewRequestWithContext(t.Context(), http.MethodDelete, s.url+"/api/gateways/"+nas.id, nil)
	token, _ := s.user("bob@home.test")
	rq.Header.Set("Authorization", "Bearer "+token)
	rs, err := http.DefaultClient.Do(rq)
	if err != nil {
		t.Fatal(err)
	}
	_ = rs.Body.Close()
	if rs.StatusCode != http.StatusForbidden || !s.b.Online(nas.id) {
		t.Fatal(rs.Status)
	}
}
