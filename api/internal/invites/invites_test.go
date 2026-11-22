package invites_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"streamiq/api/internal/apitest"
	"streamiq/api/internal/auth"
	"streamiq/api/internal/invites"
	"streamiq/api/internal/iplimit"
)

func TestMain(m *testing.M) { os.Exit(apitest.Run(m)) }

// world is alice's and bob's households, each its own admin: the Background of the
// scenarios this replaces.
type world struct {
	s              *apitest.Client
	alice, bob     string // tokens
	aliceID, bobID string
	aliceHH, bobHH string
}

func newWorld(t *testing.T, ips *iplimit.Limiter) world {
	t.Helper()
	apitest.Reset(t)
	w := world{s: apitest.Server(t, func(mux *http.ServeMux, a *auth.Auth) { invites.Routes(mux, a, apitest.DB, ips) })}
	w.alice, w.bob = apitest.Token(t, "alice@home.test"), apitest.Token(t, "bob@home.test")
	w.aliceID, w.bobID = w.s.User(t, w.alice), w.s.User(t, w.bob)
	w.aliceHH = apitest.Household(t, w.aliceID, "admin")
	w.bobHH = apitest.Household(t, w.bobID, "admin")
	apitest.Exec(t, `UPDATE tenants SET "Name" = NULL`) // previews fall back to the inviter's name
	return w
}

func (w world) create(t *testing.T, token, household string) invites.Created {
	t.Helper()
	a := w.s.Do(t, http.MethodPost, "/api/invites", token, household, "")
	if a.Status != http.StatusOK {
		t.Fatalf("create: %d", a.Status)
	}
	return apitest.JSON[invites.Created](t, a)
}

func (w world) preview(t *testing.T, token, invite string) apitest.Answer {
	t.Helper()
	return w.s.Do(t, http.MethodPost, "/api/invites/preview", token, "", `{"token":"`+invite+`"}`)
}

func (w world) accept(t *testing.T, token, invite string) apitest.Answer {
	t.Helper()
	return w.s.Do(t, http.MethodPost, "/api/invites/accept", token, "", `{"token":"`+invite+`"}`)
}

func (w world) pending(t *testing.T, token, household string) []invites.Invite {
	t.Helper()
	a := w.s.Do(t, http.MethodGet, "/api/invites", token, household, "")
	if a.Status != http.StatusOK {
		t.Fatalf("list: %d", a.Status)
	}
	return apitest.JSON[[]invites.Invite](t, a)
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

// memberships is user's households as "household:role", oldest first.
func memberships(t *testing.T, user string) string {
	t.Helper()
	return apitest.Scalar[string](
		t,
		`SELECT coalesce(string_agg("TenantId"::text || ':' || "Role", ',' ORDER BY "CreatedAt"), '')
		FROM memberships WHERE "UserId" = $1`,
		user,
	)
}

func TestAnAdminCreatesAnInvite128BitFor7DaysStoredOnlyAsItsHash(t *testing.T) {
	w := newWorld(t, iplimit.New(100, ""))
	a := w.s.Do(t, http.MethodPost, "/api/invites", w.alice, "", "")
	c := apitest.JSON[invites.Created](t, a)
	raw, err := base64.RawURLEncoding.DecodeString(c.Token)
	if a.Status != http.StatusOK || err != nil || len(raw) != 16 || !strings.HasSuffix(
		apitest.JSON[map[string]string](t, a)["expiresAt"], "Z") {
		t.Fatalf("%d %s", a.Status, a.Body)
	}
	if d := time.Until(c.ExpiresAt); d < 7*24*time.Hour-time.Minute || d > 7*24*time.Hour+time.Minute {
		t.Fatalf("expires in %v", d)
	}
	h := sha256.Sum256([]byte(c.Token))
	if got := apitest.Scalar[string](t, `SELECT "TokenHash" FROM invites WHERE "Id" = $1`, c.ID); got !=
		hex.EncodeToString(h[:]) {
		t.Fatalf("stored %s", got)
	}
	if n := apitest.Scalar[int](t, `SELECT count(*) FROM invites WHERE "TokenHash" = $1`, c.Token); n != 0 {
		t.Fatal("the plaintext token is stored")
	}
}

func TestAcceptingAnInviteMakesTheUserAMemberOfThatHouseholdOnly(t *testing.T) {
	w := newWorld(t, iplimit.New(100, ""))
	inv := w.create(t, w.alice, "")
	a := w.preview(t, w.bob, inv.Token)
	if a.Status != http.StatusOK ||
		string(a.Body) != `{"householdId":"`+w.aliceHH+`","name":"alice@home.test's household","member":false}` {
		t.Fatalf("%d %s", a.Status, a.Body)
	}
	a = w.accept(t, w.bob, inv.Token)
	if a.Status != http.StatusOK || string(a.Body) != `{"householdId":"`+w.aliceHH+`"}` {
		t.Fatalf("%d %s", a.Status, a.Body)
	}
	if got := memberships(t, w.bobID); got != w.bobHH+":admin,"+w.aliceHH+":member" {
		t.Fatal(got)
	}
	if got := memberships(t, w.aliceID); got != w.aliceHH+":admin" {
		t.Fatal(got)
	}
	if got := w.pending(t, w.alice, ""); len(got) != 0 {
		t.Fatal(got)
	}
}

func TestABrandNewUserWhoSignsUpThroughAnInviteIsInThatHouseholdOnly(t *testing.T) {
	w := newWorld(t, iplimit.New(100, ""))
	inv := w.create(t, w.alice, "")
	dave := apitest.Token(t, "dave@home.test")
	if p := apitest.JSON[invites.Preview](t, w.preview(t, dave, inv.Token)); p.Member || p.HouseholdID != w.aliceHH {
		t.Fatal(p)
	}
	status(t, w.accept(t, dave, inv.Token), http.StatusOK)
	if got := memberships(t, w.s.User(t, dave)); got != w.aliceHH+":member" {
		t.Fatal(got)
	}
}

func TestThePreviewNamesTheHouseholdElseTheInvitersAliasElseNothing(t *testing.T) {
	w := newWorld(t, iplimit.New(100, ""))
	erin := apitest.Token(t, "erin-invites@home.test") // its alias stays in the emulator: no other test uses it
	apitest.Alias(t, erin, "Erin")
	erinHH := apitest.Household(t, w.s.User(t, erin), "admin")
	apitest.Exec(t, `UPDATE tenants SET "Name" = NULL`)
	inv := w.create(t, erin, erinHH)
	name := func() *string { return apitest.JSON[invites.Preview](t, w.preview(t, w.bob, inv.Token)).Name }
	if n := name(); n == nil || *n != "Erin's household" {
		t.Fatal(n)
	}
	apitest.Exec(t, `UPDATE tenants SET "Name" = 'The Smiths' WHERE "Id" = $1`, erinHH)
	if n := name(); n == nil || *n != "The Smiths" {
		t.Fatal(n)
	}
	apitest.Exec(t, `UPDATE tenants SET "Name" = NULL`)
	apitest.Exec(t, `UPDATE invites SET "CreatedBy" = NULL`) // the inviter's account is gone
	if n := name(); n != nil {
		t.Fatal(*n)
	}
}

func TestAcceptingTwiceIsANoOpTheSecondTime(t *testing.T) {
	w := newWorld(t, iplimit.New(100, ""))
	inv := w.create(t, w.alice, "")
	status(t, w.accept(t, w.bob, inv.Token), http.StatusOK)
	a := w.accept(t, w.bob, inv.Token)
	if a.Status != http.StatusOK || string(a.Body) != `{"householdId":"`+w.aliceHH+`"}` {
		t.Fatalf("%d %s", a.Status, a.Body)
	}
	if got := memberships(t, w.bobID); got != w.bobHH+":admin,"+w.aliceHH+":member" {
		t.Fatal(got)
	}
	if p := apitest.JSON[invites.Preview](t, w.preview(t, w.bob, inv.Token)); !p.Member {
		t.Fatal("a used invite's preview for a member says not a member")
	}
}

func TestAnAdminOpeningTheirOwnInviteIsANoOpThatLeavesItPending(t *testing.T) {
	w := newWorld(t, iplimit.New(100, ""))
	inv := w.create(t, w.alice, "")
	if p := apitest.JSON[invites.Preview](t, w.preview(t, w.alice, inv.Token)); !p.Member {
		t.Fatal(p)
	}
	status(t, w.accept(t, w.alice, inv.Token), http.StatusOK)
	if got := w.pending(t, w.alice, ""); len(got) != 1 {
		t.Fatal(got)
	}
}

// Unknown, used, expired and revoked are one 404 alike, and leave the caller where they were.
func TestAnUnusableInviteIsRefusedAsNotFound(t *testing.T) {
	w := newWorld(t, iplimit.New(100, ""))
	carol := apitest.Token(t, "carol@home.test")
	carolID := w.s.User(t, carol)
	used, expired, revoked := w.create(t, w.alice, ""), w.create(t, w.alice, ""), w.create(t, w.alice, "")
	status(t, w.accept(t, w.bob, used.Token), http.StatusOK)
	apitest.Exec(t, `UPDATE invites SET "ExpiresAt" = now() - interval '1 second' WHERE "Id" = $1`, expired.ID)
	status(t, w.s.Do(t, http.MethodDelete, "/api/invites/"+revoked.ID, w.alice, "", ""), http.StatusNoContent)
	for name, token := range map[string]string{
		"used": used.Token, "expired": expired.Token, "revoked": revoked.Token,
		"unknown": "not-a-real-token", "empty": "",
	} {
		for _, a := range []apitest.Answer{w.preview(t, carol, token), w.accept(t, carol, token)} {
			if a.Status != http.StatusNotFound || len(a.Body) != 0 {
				t.Fatalf("%s: %d %s", name, a.Status, a.Body)
			}
		}
	}
	if got := memberships(t, carolID); got != "" {
		t.Fatal(got)
	}
	if got := w.pending(t, w.alice, ""); len(got) != 0 {
		t.Fatal(got)
	}
	status(t, w.s.Do(t, http.MethodPost, "/api/invites/accept", carol, "", "nope"), http.StatusBadRequest)
}

func TestAUsedInviteCannotBeRevoked(t *testing.T) {
	w := newWorld(t, iplimit.New(100, ""))
	inv := w.create(t, w.alice, "")
	status(t, w.accept(t, w.bob, inv.Token), http.StatusOK)
	status(t, w.s.Do(t, http.MethodDelete, "/api/invites/"+inv.ID, w.alice, "", ""), http.StatusNotFound)
	status(t, w.s.Do(t, http.MethodDelete, "/api/invites/not-a-uuid", w.alice, "", ""), http.StatusNotFound)
}

func TestTheListIsThePendingInvitesOldestFirst(t *testing.T) {
	w := newWorld(t, iplimit.New(100, ""))
	first, second, used := w.create(t, w.alice, ""), w.create(t, w.alice, ""), w.create(t, w.alice, "")
	status(t, w.accept(t, w.bob, used.Token), http.StatusOK)
	got := w.pending(t, w.alice, "")
	if len(got) != 2 || got[0].ID != first.ID || got[1].ID != second.ID || !got[0].ExpiresAt.Equal(first.ExpiresAt) {
		t.Fatal(got)
	}
	a := w.s.Do(t, http.MethodGet, "/api/invites", w.alice, "", "")
	if row := apitest.JSON[[]map[string]string](t, a)[0]; len(row) != 3 || !strings.HasSuffix(row["createdAt"], "Z") {
		t.Fatal(row)
	}
}

func TestAMemberCannotCreateListOrRevokeInvites(t *testing.T) {
	w := newWorld(t, iplimit.New(100, ""))
	inv := w.create(t, w.alice, "")
	status(t, w.accept(t, w.bob, inv.Token), http.StatusOK)
	other := w.create(t, w.alice, "")
	status(t, w.s.Do(t, http.MethodPost, "/api/invites", w.bob, w.aliceHH, ""), http.StatusForbidden)
	status(t, w.s.Do(t, http.MethodGet, "/api/invites", w.bob, w.aliceHH, ""), http.StatusForbidden)
	status(t, w.s.Do(t, http.MethodDelete, "/api/invites/"+other.ID, w.bob, w.aliceHH, ""), http.StatusForbidden)
	if got := w.pending(t, w.alice, ""); len(got) != 1 {
		t.Fatal(got)
	}
}

// Tenant isolation: list and revoke never show or change another household's invites,
// naming one is the not-a-member 404, an invite joins its own household only, and a
// preview tells nothing about any other household.
func TestAnotherHouseholdsInvitesAreOutOfReach(t *testing.T) {
	w := newWorld(t, iplimit.New(100, ""))
	inv := w.create(t, w.alice, "")
	if got := w.pending(t, w.bob, ""); len(got) != 0 {
		t.Error(got)
	}
	check(t, w.s.Do(t, http.MethodDelete, "/api/invites/"+inv.ID, w.bob, w.bobHH, ""), http.StatusNotFound)
	for _, a := range []apitest.Answer{
		w.s.Do(t, http.MethodGet, "/api/invites", w.bob, w.aliceHH, ""),
		w.s.Do(t, http.MethodPost, "/api/invites", w.bob, w.aliceHH, ""),
		w.s.Do(t, http.MethodDelete, "/api/invites/"+inv.ID, w.bob, w.aliceHH, ""),
	} {
		if a.Status != http.StatusNotFound || a.Header.Get(auth.NotMemberHeader) != "1" {
			t.Error(a.Status)
		}
	}
	if got := w.pending(t, w.alice, ""); len(got) != 1 {
		t.Error(got)
	}
}

func TestAnInviteJoinsItsOwnHouseholdOnlyWhateverTheRequestNames(t *testing.T) {
	w := newWorld(t, iplimit.New(100, ""))
	carol := apitest.Token(t, "carol@home.test")
	carolID := w.s.User(t, carol)
	carolHH := apitest.Household(t, carolID, "admin")
	inv := w.create(t, w.alice, "")
	// Carol acts in her own household; the invite still joins alice's, and only that.
	a := w.s.Do(t, http.MethodPost, "/api/invites/accept", carol, carolHH, `{"token":"`+inv.Token+`"}`)
	if a.Status != http.StatusOK || string(a.Body) != `{"householdId":"`+w.aliceHH+`"}` {
		t.Fatalf("%d %s", a.Status, a.Body)
	}
	if got := memberships(t, carolID); got != carolHH+":admin,"+w.aliceHH+":member" {
		t.Fatal(got)
	}
	if n := apitest.Scalar[int](t, `SELECT count(*) FROM memberships WHERE "TenantId" = $1`, w.bobHH); n != 1 {
		t.Fatalf("bob's household has %d members", n)
	}
	// Naming a household that isn't the caller's is the not-a-member 404, as everywhere.
	a = w.s.Do(t, http.MethodPost, "/api/invites/preview", w.bob, w.aliceHH, `{"token":"`+inv.Token+`"}`)
	if a.Status != http.StatusNotFound || a.Header.Get(auth.NotMemberHeader) != "1" {
		t.Fatal(a.Status)
	}
}

func TestAPreviewTellsNothingAboutAnyOtherHousehold(t *testing.T) {
	w := newWorld(t, iplimit.New(100, ""))
	apitest.Exec(t, `UPDATE tenants SET "Name" = 'Bob''s place' WHERE "Id" = $1`, w.bobHH)
	inv := w.create(t, w.alice, "")
	for _, token := range []string{w.bob, apitest.Token(t, "dave@home.test")} {
		a := w.preview(t, token, inv.Token)
		if p := apitest.JSON[invites.Preview](
			t,
			a,
		); p.HouseholdID != w.aliceHH ||
			strings.Contains(string(a.Body), w.bobHH) ||
			strings.Contains(string(a.Body), "Bob") {
			t.Fatalf("%s", a.Body)
		}
	}
}

func TestOneInviteAcceptedByTwoUsersAtOnceGivesOneNewMember(t *testing.T) {
	w := newWorld(t, iplimit.New(100, ""))
	inv := w.create(t, w.alice, "")
	carol := apitest.Token(t, "carol@home.test")
	w.s.User(t, carol)
	// Both claims wait on the invite's row until this transaction ends.
	tx, err := apitest.Owner.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `SELECT FROM invites WHERE "Id" = $1 FOR UPDATE`, inv.ID); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	got := make([]int, 2)
	for i, token := range []string{w.bob, carol} {
		wg.Go(func() { got[i] = w.accept(t, token, inv.Token).Status })
	}
	apitest.WaitForLocks(t, 2)
	_ = tx.Commit(t.Context())
	wg.Wait()
	if slices.Sort(got); !slices.Equal(got, []int{200, 404}) {
		t.Fatalf("%v, want one 200 and one 404", got)
	}
	if n := apitest.Scalar[int](t, `SELECT count(*) FROM memberships WHERE "TenantId" = $1`, w.aliceHH); n != 2 {
		t.Fatalf("%d members, want alice and one more", n)
	}
}

// Joined concurrently (another invite or tab): the membership's key refuses the second
// row; the answer is the household and this invite stays unspent.
func TestAcceptingWhenAlreadyJoinedConcurrentlyLeavesTheInviteUnspent(t *testing.T) {
	w := newWorld(t, iplimit.New(100, ""))
	inv := w.create(t, w.alice, "")
	// The caller's households are read before the claim: a membership added in between
	// is what a concurrent join looks like. A trigger adds it right before the insert.
	apitest.Exec(t, `CREATE FUNCTION race_join() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
		INSERT INTO memberships ("TenantId", "UserId", "Role") VALUES (NEW."TenantId", NEW."UserId", 'member')
		ON CONFLICT DO NOTHING; RETURN NEW; END $$`)
	apitest.Exec(t, `CREATE TRIGGER race BEFORE INSERT ON memberships FOR EACH ROW WHEN (pg_trigger_depth() = 0)
		EXECUTE FUNCTION race_join()`)
	t.Cleanup(func() {
		_, _ = apitest.Owner.Exec(context.Background(), `DROP TRIGGER race ON memberships; DROP FUNCTION race_join()`)
	})
	a := w.accept(t, w.bob, inv.Token)
	if a.Status != http.StatusOK || string(a.Body) != `{"householdId":"`+w.aliceHH+`"}` {
		t.Fatalf("%d %s", a.Status, a.Body)
	}
	if used := apitest.Scalar[bool](t, `SELECT "UsedAt" IS NOT NULL FROM invites WHERE "Id" = $1`, inv.ID); used {
		t.Fatal("the invite was spent")
	}
}

// New invites spend the client IP's one budget, whatever else spent it.
func TestNewInvitesAreLimitedPerClientIP(t *testing.T) {
	ips := iplimit.New(3, "X-Real-IP")
	w := newWorld(t, ips)
	rq := httptest.NewRequest(http.MethodGet, "/", nil) // e.g. a broker socket
	rq.Header.Set("X-Real-IP", "203.0.113.1")
	ips.Wrap(func(http.ResponseWriter, *http.Request) {})(httptest.NewRecorder(), rq)
	create := func(ip string) int {
		return w.s.Do(t, http.MethodPost, "/api/invites", w.alice, "", "", "X-Real-IP", ip).Status
	}
	got := []int{create("203.0.113.1"), create("203.0.113.1"), create("203.0.113.1"), create("203.0.113.2")}
	if got[0] != 200 || got[1] != 200 || got[2] != 429 || got[3] != 200 {
		t.Fatal(got)
	}
}

// A user in no household gets the not-a-member 404 on the household's invites, as on
// everything household-scoped: the web app shows its no-household screen.
func TestAUserInNoHouseholdHasNoInvites(t *testing.T) {
	w := newWorld(t, iplimit.New(100, ""))
	nohome := apitest.Token(t, "nohome@home.test")
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		if a := w.s.Do(t, method, "/api/invites", nohome, "", ""); a.Status != http.StatusNotFound ||
			a.Header.Get(auth.NotMemberHeader) != "1" {
			t.Fatalf("%s: %d", method, a.Status)
		}
	}
}
