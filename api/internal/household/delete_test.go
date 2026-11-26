package household_test

import (
	"net/http"
	"slices"
	"sync"
	"testing"

	"streamiq/api/internal/apitest"
	"streamiq/api/internal/auth"
	"streamiq/api/internal/iplimit"
)

// home is alice's household (bob a member, one gateway, an invite, an enrollment token,
// a month of relay usage) next to dave's cabin, which bob is in too.
type home struct {
	s                *apitest.Client
	alice, bob, dave string
	bobUser          string
	id, cabin, nas   string
}

func newHome(t *testing.T) home {
	t.Helper()
	h := home{s: server(t, iplimit.New(100, ""))}
	h.alice, h.bob, h.dave = apitest.Token(t, "alice@home.test"), apitest.Token(t, "bob@home.test"),
		apitest.Token(t, "dave@home.test")
	h.bobUser = h.s.User(t, h.bob)
	h.id = apitest.Household(t, h.s.User(t, h.alice), "admin")
	h.cabin = apitest.Household(t, h.s.User(t, h.dave), "admin")
	apitest.Join(t, h.bobUser, h.id, "member")
	apitest.Join(t, h.bobUser, h.cabin, "member")
	for _, tenant := range []string{h.cabin, h.id} {
		h.nas = apitest.Scalar[string](t, `INSERT INTO gateways (id, tenant_id, name, credential_hash)
			VALUES (uuidv7(), $1, 'nas', uuidv7()::text) RETURNING id::text`, tenant)
		apitest.Exec(t, `INSERT INTO invites (id, tenant_id, token_hash, expires_at)
			VALUES (uuidv7(), $1, uuidv7()::text, now() + interval '1 day')`, tenant)
		apitest.Exec(t, `INSERT INTO enrollment_tokens (id, tenant_id, token_hash, expires_at)
			VALUES (uuidv7(), $1, uuidv7()::text, now() + interval '1 day')`, tenant)
		apitest.Exec(t, `INSERT INTO relay_usage (tenant_id, gateway_id, month, bytes)
			VALUES ($1, uuidv7(), date_trunc('month', now()), 1)`, tenant)
	}
	return h
}

func (h home) remove(t *testing.T, token, household string) apitest.Answer {
	return h.s.Do(t, http.MethodDelete, "/api/households/current", token, household, "")
}

// rows counts household's rows in every tenant-owned table.
func rows(t *testing.T, household string) int {
	return apitest.Scalar[int](t, `SELECT (SELECT count(*) FROM tenants WHERE id = $1)
		+ (SELECT count(*) FROM memberships WHERE tenant_id = $1) + (SELECT count(*) FROM gateways WHERE tenant_id = $1)
		+ (SELECT count(*) FROM invites WHERE tenant_id = $1) + (SELECT count(*) FROM relay_usage WHERE tenant_id = $1)
		+ (SELECT count(*) FROM enrollment_tokens WHERE tenant_id = $1)`,
		household)
}

func TestAnAdminDeletesTheHouseholdWithEverythingInIt(t *testing.T) {
	h := newHome(t)
	if a := h.remove(t, h.alice, h.id); a.Status != http.StatusNoContent {
		t.Fatalf("%d %s", a.Status, a.Body)
	}
	if n := rows(t, h.id); n != 0 {
		t.Fatalf("%d rows left", n)
	}
	if !slices.Equal(closed, []string{h.nas}) {
		t.Fatalf("closed %v, want the household's gateway %s", closed, h.nas)
	}
	// Bob is still in the cabin, untouched; alice is in no household now.
	if n := rows(t, h.cabin); n != 7 {
		t.Fatalf("the cabin has %d rows, want 7", n)
	}
	if a := h.s.Do(t, http.MethodPut, "/api/households/current/name", h.alice, h.id, `{"name":"x"}`); a.Status !=
		http.StatusNotFound || a.Header.Get(auth.NotMemberHeader) != "1" {
		t.Fatalf("the deleted household: %d", a.Status)
	}
}

func TestOnlyAnAdminOfTheHouseholdDeletesIt(t *testing.T) {
	h := newHome(t)
	if a := h.remove(t, h.bob, h.id); a.Status != http.StatusForbidden {
		t.Fatalf("member: %d", a.Status)
	}
	// Dave names alice's household: not his, the usual 404, also with none named.
	if a := h.remove(t, h.dave, h.id); a.Status != http.StatusNotFound || a.Header.Get(auth.NotMemberHeader) != "1" {
		t.Fatalf("non-member: %d", a.Status)
	}
	if a := h.remove(t, apitest.Token(t, "nohome@home.test"), ""); a.Status != http.StatusNotFound {
		t.Fatalf("no household: %d", a.Status)
	}
	if a := h.remove(t, "", h.id); a.Status != http.StatusUnauthorized {
		t.Fatalf("signed out: %d", a.Status)
	}
	if n, m := rows(t, h.id), rows(t, h.cabin); n != 7 || m != 7 || closed != nil {
		t.Fatalf("rows %d, %d; closed %v", n, m, closed)
	}
}

// The function checks the role itself: called for a member, it deletes nothing.
func TestDeleteHouseholdRefusesAMember(t *testing.T) {
	h := newHome(t)
	if got := apitest.Scalar[*[]string](t, `SELECT delete_household($1, $2)::text[]`, h.id, h.bobUser); got != nil {
		t.Fatalf("%v, want NULL", *got)
	}
	if n := rows(t, h.id); n != 7 {
		t.Fatalf("%d rows", n)
	}
}

// An admin demoted while the delete waits on the household's lock deletes nothing.
func TestAnAdminDemotedWhileDeletingDeletesNothing(t *testing.T) {
	h := newHome(t)
	tx, err := apitest.Owner.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `SELECT FROM tenants WHERE id = $1 FOR UPDATE`, h.id); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var got int
	wg.Go(func() { got = h.remove(t, h.alice, h.id).Status })
	apitest.WaitForLocks(t, 1)
	if _, err := tx.Exec(t.Context(), `UPDATE memberships SET role = 'member' WHERE tenant_id = $1`, h.id); err != nil {
		t.Fatal(err)
	}
	_ = tx.Commit(t.Context())
	wg.Wait()
	if n := rows(t, h.id); got != http.StatusForbidden || n != 7 {
		t.Fatalf("%d, %d rows", got, n)
	}
}
