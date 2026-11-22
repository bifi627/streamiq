package members_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"streamiq/api/internal/apitest"
	"streamiq/api/internal/auth"
	"streamiq/api/internal/members"
)

func TestMain(m *testing.M) { os.Exit(apitest.Run(m)) }

// home is alice's household (admin) with bob as a member: the Background of the
// scenarios this replaces.
type home struct {
	s          *apitest.Client
	alice, bob string // tokens
	aliceID    string
	bobID      string
	id         string
}

func newHome(t *testing.T) home {
	t.Helper()
	apitest.Reset(t)
	h := home{s: apitest.Server(t, func(mux *http.ServeMux, a *auth.Auth) { members.Routes(mux, a, apitest.DB) })}
	h.alice, h.bob = apitest.Token(t, "alice@home.test"), apitest.Token(t, "bob@home.test")
	h.aliceID, h.bobID = h.s.User(t, h.alice), h.s.User(t, h.bob)
	h.id = apitest.Household(t, h.aliceID, "admin")
	apitest.Join(t, h.bobID, h.id, "member")
	return h
}

func (h home) list(t *testing.T, token string) apitest.Answer {
	t.Helper()
	return h.s.Do(t, http.MethodGet, "/api/members", token, h.id, "")
}

func (h home) remove(t *testing.T, token, user string) apitest.Answer {
	t.Helper()
	return h.s.Do(t, http.MethodDelete, "/api/members/"+user, token, h.id, "")
}

func (h home) role(t *testing.T, token, user, role string) apitest.Answer {
	t.Helper()
	return h.s.Do(t, http.MethodPut, "/api/members/"+user+"/role", token, h.id, `{"role":"`+role+`"}`)
}

// names is the list as "name:role" in order, "" for a null name.
func names(t *testing.T, a apitest.Answer) string {
	t.Helper()
	if a.Status != http.StatusOK {
		t.Fatalf("list: %d", a.Status)
	}
	var out []string
	for _, m := range apitest.JSON[[]members.Member](t, a) {
		n := ""
		if m.Name != nil {
			n = *m.Name
		}
		out = append(out, n+":"+m.Role)
	}
	return strings.Join(out, ", ")
}

func status(t *testing.T, a apitest.Answer, want int) {
	t.Helper()
	if a.Status != want {
		t.Fatalf("%d %s, want %d", a.Status, a.Body, want)
	}
}

// check is status that lets the test go on: an isolation test shows every leak at once.
func check(t *testing.T, a apitest.Answer, want int) {
	t.Helper()
	if a.Status != want {
		t.Errorf("%d %s, want %d", a.Status, a.Body, want)
	}
}

func TestAMemberListsTheHouseholdOldestFirstWithNamesFromFirebase(t *testing.T) {
	h := newHome(t)
	a := h.list(t, h.bob)
	if got := names(t, a); got != "alice@home.test:admin, bob@home.test:member" {
		t.Fatal(got)
	}
	// The wire shape: email only on the caller's row, joinedAt in UTC.
	rows := apitest.JSON[[]map[string]any](t, a)
	if _, ok := rows[0]["email"]; ok || rows[1]["email"] != "bob@home.test" || rows[0]["userId"] != h.aliceID ||
		!strings.HasSuffix(rows[0]["joinedAt"].(string), "Z") || len(rows[0]) != 4 || len(rows[1]) != 5 {
		t.Fatalf("%s", a.Body)
	}
}

func TestAliasesReplaceEmailsAndEachMemberGetsOnlyTheirOwnEmail(t *testing.T) {
	h := newHome(t)
	erin := apitest.Token(t, "erin-members@home.test") // its alias stays in the emulator: no other test uses it
	apitest.Alias(t, erin, "Erin")
	apitest.Join(t, h.s.User(t, erin), h.id, "member")
	for token, email := range map[string]string{h.alice: "alice@home.test", erin: "erin-members@home.test"} {
		a := h.list(t, token)
		if got := names(t, a); got != "alice@home.test:admin, bob@home.test:member, Erin:member" {
			t.Fatal(got)
		}
		var emails []string
		for _, m := range apitest.JSON[[]members.Member](t, a) {
			if m.Email != "" {
				emails = append(emails, m.Email)
			}
		}
		if len(emails) != 1 || emails[0] != email {
			t.Fatalf("emails %v, want only %s", emails, email)
		}
	}
}

func TestWithFirebaseUnreachableTheListAnswersWithoutNames(t *testing.T) {
	h := newHome(t)
	// In front of the emulator: a lookup of two or more accounts (the list's) fails, one
	// account (the token's revocation check, emulator only) passes.
	up, _ := url.Parse("http://" + apitest.Emulator)
	proxy := httputil.NewSingleHostReverseProxy(up)
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
		var rq struct{ LocalID []string }
		if json.Unmarshal(body, &rq) == nil && len(rq.LocalID) > 1 {
			w.WriteHeader(http.StatusBadRequest) // not a 5xx: the SDK retries those
			return
		}
		proxy.ServeHTTP(w, r)
	}))
	defer front.Close()
	t.Setenv("FIREBASE_AUTH_EMULATOR_HOST", strings.TrimPrefix(front.URL, "http://"))
	s := apitest.Server(t, func(mux *http.ServeMux, a *auth.Auth) { members.Routes(mux, a, apitest.DB) })
	a := s.Do(t, http.MethodGet, "/api/members", h.alice, h.id, "")
	if got := names(t, a); got != ":admin, :member" || strings.Contains(string(a.Body), "email") {
		t.Fatalf("%s", a.Body)
	}
}

func TestAnAdminRemovesAMemberWhoThenGets404There(t *testing.T) {
	h := newHome(t)
	own := apitest.Household(t, h.bobID, "admin")
	status(t, h.remove(t, h.alice, h.bobID), http.StatusNoContent)
	status(t, h.list(t, h.bob), http.StatusNotFound)
	if got := names(t, h.list(t, h.alice)); got != "alice@home.test:admin" {
		t.Fatal(got)
	}
	if got := names(t, h.s.Do(t, http.MethodGet, "/api/members", h.bob, "", "")); got != "bob@home.test:admin" {
		t.Fatalf("bob's own household %s: %s", own, got)
	}
}

func TestAMemberLeavesThenGets404There(t *testing.T) {
	h := newHome(t)
	status(t, h.remove(t, h.bob, h.bobID), http.StatusNoContent)
	if a := h.list(t, h.bob); a.Status != http.StatusNotFound || a.Header.Get(auth.NotMemberHeader) != "1" {
		t.Fatal(a.Status)
	}
}

func TestAMemberCannotRemoveAnyoneElseOrChangeRoles(t *testing.T) {
	h := newHome(t)
	status(t, h.remove(t, h.bob, h.aliceID), http.StatusForbidden)
	status(t, h.role(t, h.bob, h.bobID, "admin"), http.StatusForbidden)
	if got := names(t, h.list(t, h.alice)); got != "alice@home.test:admin, bob@home.test:member" {
		t.Fatal(got)
	}
}

func TestAnAdminPromotesAndDemotesTheRoleAppliesOnTheNextRequest(t *testing.T) {
	h := newHome(t)
	status(t, h.role(t, h.alice, h.bobID, "admin"), http.StatusNoContent)
	status(t, h.role(t, h.bob, h.aliceID, "member"), http.StatusNoContent) // bob acts as admin now
	status(t, h.role(t, h.alice, h.bobID, "member"), http.StatusForbidden) // alice doesn't
	if got := names(t, h.list(t, h.bob)); got != "alice@home.test:member, bob@home.test:admin" {
		t.Fatal(got)
	}
}

func TestARoleIsAdminOrMember(t *testing.T) {
	h := newHome(t)
	for _, body := range []string{`{"role":"owner"}`, `{"role":"Admin"}`, `{}`, `{"role":null}`, `nope`} {
		a := h.s.Do(t, http.MethodPut, "/api/members/"+h.bobID+"/role", h.alice, h.id, body)
		status(t, a, http.StatusBadRequest)
	}
	status(t, h.role(t, h.alice, "not-a-uuid", "admin"), http.StatusNotFound)
	status(t, h.remove(t, h.alice, "not-a-uuid"), http.StatusNotFound)
}

func TestRemovingAMemberDeletesTheirPendingInvitesDemotingKeepsThem(t *testing.T) {
	h := newHome(t)
	status(t, h.role(t, h.alice, h.bobID, "admin"), http.StatusNoContent)
	invite := func(by, hash string) {
		apitest.Exec(t, `INSERT INTO invites ("Id", "TenantId", "TokenHash", "CreatedBy", "ExpiresAt")
			VALUES (uuidv7(), $1, $2, $3, now() + interval '7 days')`, h.id, hash, by)
	}
	invite(h.bobID, "bob's")
	invite(h.aliceID, "alice's")
	other := apitest.Household(t, h.bobID, "admin")
	apitest.Exec(t, `INSERT INTO invites ("Id", "TenantId", "TokenHash", "CreatedBy", "ExpiresAt")
		VALUES (uuidv7(), $1, 'bob''s elsewhere', $2, now() + interval '7 days')`, other, h.bobID)
	pending := func() string {
		return apitest.Scalar[string](t, `SELECT string_agg("TokenHash", ',' ORDER BY "TokenHash") FROM invites`)
	}

	status(t, h.role(t, h.alice, h.bobID, "member"), http.StatusNoContent)
	if got := pending(); got != "alice's,bob's,bob's elsewhere" {
		t.Fatalf("after demoting: %s", got)
	}
	status(t, h.remove(t, h.alice, h.bobID), http.StatusNoContent)
	if got := pending(); got != "alice's,bob's elsewhere" {
		t.Fatalf("after removing: %s", got)
	}
}

func TestTheLastAdminCannotLeaveOrDemoteThemselves(t *testing.T) {
	h := newHome(t)
	for _, a := range []apitest.Answer{h.remove(t, h.alice, h.aliceID), h.role(t, h.alice, h.aliceID, "member")} {
		if a.Status != http.StatusConflict || a.Header.Get("Content-Type") != "application/json; charset=utf-8" ||
			string(a.Body) != `{"error":"`+members.LastAdmin+`"}` {
			t.Fatalf("%d %s", a.Status, a.Body)
		}
	}
	status(t, h.role(t, h.alice, h.bobID, "admin"), http.StatusNoContent)
	status(t, h.remove(t, h.alice, h.aliceID), http.StatusNoContent)
}

func TestTwoAdminsDemotingEachOtherAtOnceLeaveOneAdmin(t *testing.T) {
	h := newHome(t)
	status(t, h.role(t, h.alice, h.bobID, "admin"), http.StatusNoContent)
	// Both requests wait in the household's lock until this transaction ends.
	tx, err := apitest.Owner.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `SELECT FROM tenants WHERE "Id" = $1 FOR UPDATE`, h.id); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	got := make([]int, 2)
	for i, pair := range [][2]string{{h.alice, h.bobID}, {h.bob, h.aliceID}} {
		wg.Go(func() { got[i] = h.role(t, pair[0], pair[1], "member").Status })
	}
	time.Sleep(200 * time.Millisecond) // ponytail: both are waiting by then; the result holds either way
	_ = tx.Commit(t.Context())
	wg.Wait()
	if !(got[0] == 204 && got[1] == 409 || got[0] == 409 && got[1] == 204) {
		t.Fatalf("%v, want one 204 and one 409", got)
	}
	if n := apitest.Scalar[int](t, `SELECT count(*) FROM memberships WHERE "TenantId" = $1 AND "Role" = 'admin'`,
		h.id); n != 1 {
		t.Fatalf("%d admins", n)
	}
}

// Tenant isolation: list, remove and role never show or change another household's
// members, also for a user who is in both.
func TestAnotherHouseholdsMembersAreOutOfReach(t *testing.T) {
	h := newHome(t)
	carol, dave := apitest.Token(t, "carol@home.test"), apitest.Token(t, "dave@home.test")
	carolID := h.s.User(t, carol)
	cabin := apitest.Household(t, h.s.User(t, dave), "admin")
	apitest.Join(t, carolID, cabin, "member")
	apitest.Join(t, h.bobID, cabin, "member")

	check(t, h.role(t, h.alice, carolID, "admin"), http.StatusNotFound)
	check(t, h.remove(t, h.alice, carolID), http.StatusNotFound)
	if got := names(t, h.list(t, h.alice)); got != "alice@home.test:admin, bob@home.test:member" {
		t.Error(got)
	}
	// Bob is in both: removing him from alice's household leaves his membership in dave's.
	check(t, h.remove(t, h.alice, h.bobID), http.StatusNoContent)
	if got := names(t, h.s.Do(t, http.MethodGet, "/api/members", dave, cabin, "")); got !=
		"dave@home.test:admin, carol@home.test:member, bob@home.test:member" {
		t.Error(got)
	}
	// Naming a household the caller isn't in is the not-a-member 404, for all three.
	for _, a := range []apitest.Answer{
		h.s.Do(t, http.MethodGet, "/api/members", h.alice, cabin, ""),
		h.s.Do(t, http.MethodDelete, "/api/members/"+carolID, h.alice, cabin, ""),
		h.s.Do(t, http.MethodPut, "/api/members/"+carolID+"/role", h.alice, cabin, `{"role":"admin"}`),
	} {
		if a.Status != http.StatusNotFound || a.Header.Get(auth.NotMemberHeader) != "1" {
			t.Error(a.Status)
		}
	}
	if n := apitest.Scalar[int](t, `SELECT count(*) FROM memberships WHERE "TenantId" = $1`, cabin); n != 3 {
		t.Errorf("dave's household has %d members, want 3", n)
	}
}

func TestLeavingTheLastHouseholdLeavesTheUserInNone(t *testing.T) {
	h := newHome(t)
	own := apitest.Household(t, h.bobID, "admin")
	apitest.Join(t, h.aliceID, own, "admin")
	status(t, h.s.Do(t, http.MethodDelete, "/api/members/"+h.bobID, h.bob, own, ""), http.StatusNoContent)
	status(t, h.remove(t, h.bob, h.bobID), http.StatusNoContent)
	if n := apitest.Scalar[int](t, `SELECT count(*) FROM memberships WHERE "UserId" = $1`, h.bobID); n != 0 {
		t.Fatal(n)
	}
	if a := h.s.Do(t, http.MethodGet, "/api/members", h.bob, "", ""); a.Status != http.StatusNotFound ||
		a.Header.Get(auth.NotMemberHeader) != "1" {
		t.Fatal(a.Status) // no household: what the web app's no-household screen keys on
	}
}

func TestSignedOutOrABadTokenIs401(t *testing.T) {
	h := newHome(t)
	for _, token := range []string{"", "garbage"} {
		status(t, h.s.Do(t, http.MethodGet, "/api/members", token, "", ""), http.StatusUnauthorized)
	}
}
