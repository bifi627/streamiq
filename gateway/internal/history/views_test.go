package history

import (
	"net/http"
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
	rt := viewsAPI(&Views{Store: &Store{Dir: t.TempDir(), Kind: "views"}})
	u1 := tunnel.Session{User: "u1"}
	for _, id := range []string{item1, item2, item1} {
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
	rt := viewsAPI(&Views{Store: &Store{Dir: t.TempDir(), Kind: "views"}})
	u1 := tunnel.Session{User: "u1"}
	for range ViewLimit + 1 {
		add(t, rt, u1, `{"itemId":"`+item1+`"}`)
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
