package history

import (
	"net/http"
	"sync"
	"testing"
	"time"

	"streamiq/gateway/internal/tunnel"
)

const item1, item2 = "0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"

func viewsAPI(v *Views) *tunnel.Router {
	rt := tunnel.NewRouter()
	rt.Handle("GET "+ViewsPath, http.HandlerFunc(v.ServeList))
	rt.Handle("POST "+ViewsPath, http.HandlerFunc(v.ServeAdd))
	return rt
}

func add(t *testing.T, rt *tunnel.Router, who tunnel.Session, body string) int {
	t.Helper()
	status, _, _, _ := tunnel.Do(rt, who, "POST", ViewsPath, body)
	return status
}

func TestEachViewIsItsOwnEntryNewestFirst(t *testing.T) {
	s := &Store{Dir: t.TempDir(), Kind: "views"}
	rt := viewsAPI(&Views{Store: s})
	u1 := tunnel.Session{User: "u1"}
	seedView(t, s, "u1", item1, time.Now().Add(-ViewWindow-time.Minute))
	for _, id := range []string{item2, item1} {
		if s := add(t, rt, u1, `{"itemId":"`+id+`"}`); s != http.StatusNoContent {
			t.Fatalf("add: %d", s)
		}
	}
	_, got := get[[]View](t, rt, u1, ViewsPath)
	if len(got) != 3 || got[0].ItemID != item1 || got[1].ItemID != item2 || got[2].ItemID != item1 {
		t.Fatalf("views %+v", got)
	}
	if got[0].UserID != "" || got[0].At.Before(got[2].At) {
		t.Fatalf("first %+v, last %+v", got[0], got[2])
	}
}

func TestViewsAreOnlyTheSessionUsers(t *testing.T) {
	rt := viewsAPI(&Views{Store: &Store{Dir: t.TempDir(), Kind: "views"}})
	add(t, rt, tunnel.Session{User: "u1"}, `{"itemId":"`+item1+`"}`)
	for _, who := range []tunnel.Session{{User: "u2"}, {}} {
		if _, got := get[[]View](t, rt, who, ViewsPath); len(got) != 0 {
			t.Fatalf("%q sees %+v", who.User, got)
		}
	}
}

func TestABadViewIsRefused(t *testing.T) {
	rt := viewsAPI(&Views{Store: &Store{Dir: t.TempDir(), Kind: "views"}})
	for _, body := range []string{``, `{}`, `{"itemId":"../x"}`, `{"itemId":"` + item1 + `abcde"}`} {
		if s := add(t, rt, tunnel.Session{User: "u1"}, body); s != http.StatusBadRequest {
			t.Errorf("%q: %d", body, s)
		}
	}
	if s := add(t, rt, tunnel.Session{}, `{"itemId":"`+item1+`"}`); s != http.StatusForbidden {
		t.Errorf("no user: %d", s)
	}
}

func TestTheViewsAreKeptForever(t *testing.T) {
	s := &Store{Dir: t.TempDir(), Kind: "views"}
	now := time.Now().UTC()
	old := now.AddDate(-5, 0, 0)
	for _, at := range []time.Time{old, now} {
		if err := s.Append(at, View{ItemID: item1, At: at, UserID: "u1"}); err != nil {
			t.Fatal(err)
		}
	}
	rows, _ := Read[View](s)
	if len(rows) != 2 || !rows[0].At.Equal(old) {
		t.Fatalf("rows %+v", rows)
	}
}

func TestOneItemsViewsAreAllOfThemAndOnlyTheUsers(t *testing.T) {
	s := &Store{Dir: t.TempDir(), Kind: "views"}
	rt := viewsAPI(&Views{Store: s})
	u1 := tunnel.Session{User: "u1"}
	for i := range ViewLimit + 1 {
		seedView(t, s, "u1", item1, time.Now().Add(-time.Duration(ViewLimit+1-i)*ViewWindow))
	}
	add(t, rt, u1, `{"itemId":"`+item2+`"}`)
	add(t, rt, tunnel.Session{User: "u2"}, `{"itemId":"`+item1+`"}`)
	if _, got := get[[]View](t, rt, u1, ViewsPath+"?itemId="+item1); len(got) != ViewLimit+1 || got[0].ItemID != item1 {
		t.Fatalf("u1 item1: %d views", len(got))
	}
	if _, got := get[[]View](t, rt, u1, ViewsPath+"?itemId="+item2); len(got) != 1 {
		t.Fatalf("u1 item2: %+v", got)
	}
	if _, got := get[[]View](t, rt, u1, ViewsPath); len(got) != ViewLimit {
		t.Fatalf("u1 all: %d views", len(got))
	}
	if _, got := get[[]View](t, rt, tunnel.Session{}, ViewsPath+"?itemId="+item1); len(got) != 0 {
		t.Fatalf("no user: %+v", got)
	}
	for _, q := range []string{"?itemId=../x", "?itemId=", "?itemId=" + item1 + "&itemId=" + item2} {
		if s, _ := get[any](t, rt, u1, ViewsPath+q); s != http.StatusBadRequest {
			t.Errorf("%s: %d", q, s)
		}
	}
}

func seedView(t *testing.T, s *Store, user, item string, at time.Time) {
	t.Helper()
	if err := s.Append(at, View{ItemID: item, At: at.UTC(), UserID: user}); err != nil {
		t.Fatal(err)
	}
}

func count(t *testing.T, rt *tunnel.Router, who tunnel.Session, item string) int {
	t.Helper()
	_, got := get[[]View](t, rt, who, ViewsPath+"?itemId="+item)
	return len(got)
}

func TestAViewWithin3HoursOfTheUsersLastOfThatItemIsTheSameWatch(t *testing.T) {
	s := &Store{Dir: t.TempDir(), Kind: "views"}
	rt := viewsAPI(&Views{Store: s})
	u1, u2 := tunnel.Session{User: "u1"}, tunnel.Session{User: "u2"}
	seedView(t, s, "u1", item1, time.Now().Add(-ViewWindow+time.Minute))
	seedView(t, s, "u1", item2, time.Now().Add(-ViewWindow-time.Minute))
	for _, c := range []struct {
		who  tunnel.Session
		item string
		want int
	}{
		{u1, item1, 1}, // within: not stored
		{u1, item2, 2}, // outside: stored
		{u2, item1, 1}, // another user: stored
	} {
		if st := add(t, rt, c.who, `{"itemId":"`+c.item+`"}`); st != http.StatusNoContent {
			t.Fatalf("add: %d", st)
		}
		if n := count(t, rt, c.who, c.item); n != c.want {
			t.Errorf("%s %s: %d views, want %d", c.who.User, c.item, n, c.want)
		}
	}
}

func TestConcurrentViewsOfOneItemAreOneView(t *testing.T) {
	rt := viewsAPI(&Views{Store: &Store{Dir: t.TempDir(), Kind: "views"}})
	u1 := tunnel.Session{User: "u1"}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() { add(t, rt, u1, `{"itemId":"`+item1+`"}`) })
	}
	wg.Wait()
	if n := count(t, rt, u1, item1); n != 1 {
		t.Fatalf("%d views", n)
	}
}

func TestAppendUnlessSeesYesterdaysFile(t *testing.T) {
	s := &Store{Dir: t.TempDir(), Kind: "views"}
	midnight := time.Date(2026, 11, 27, 0, 0, 0, 0, time.UTC)
	seedView(t, s, "u1", item1, midnight.Add(-time.Hour))
	mine := func(l View) bool { return l.UserID == "u1" }
	if err := AppendUnless(s, midnight.Add(time.Hour), View{ItemID: item1, UserID: "u1"}, mine); err != nil {
		t.Fatal(err)
	}
	if rows, _ := Read[View](s); len(rows) != 1 {
		t.Fatalf("rows %+v", rows)
	}
}
