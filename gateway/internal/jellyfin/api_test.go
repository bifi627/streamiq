package jellyfin

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"streamiq/gateway/internal/tunnel"
)

func libAPI(s *Setup) *tunnel.Router {
	rt := tunnel.NewRouter()
	rt.Handle("GET "+LibrariesPath, http.HandlerFunc(s.ServeLibraries))
	rt.Handle("POST "+LibrariesOfflinePath, http.HandlerFunc(s.ServeOffline))
	rt.Handle("POST "+LibrariesExtrasPath, http.HandlerFunc(s.ServeExtras))
	rt.Handle("POST "+LibrariesRescanPath, http.HandlerFunc(s.ServeRescan))
	return rt
}

// The gateway API's library endpoints on a managed Jellyfin (admin-only is
// cmd/gateway's route table test): the list with its scan state, the #322
// writes, Rescan, and Jellyfin's errors with its message.
func TestLibrariesAPI(t *testing.T) {
	f, srv := newFake(t, false)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	s.poll(context.Background())
	rt := libAPI(s)
	do := func(method, url, body string) (int, string) {
		st, _, reply, _ := tunnel.Do(rt, tunnel.Session{Role: tunnel.Admin}, method, url, body)
		return st, reply
	}
	if st, reply := do("GET", LibrariesPath, ""); st != 200 || reply != "[]" {
		t.Fatalf("no libraries: %d %s", st, reply)
	}
	f.mu.Lock()
	f.libs = []map[string]any{lib("a", "movies", []any{}), lib("b", "movies", []any{})}
	f.libs[1]["RefreshProgress"] = 7.0
	f.mu.Unlock()
	want := `[{"id":"a","name":"lib a","offline":false,"extras":"off","scanning":false,"progress":0},` +
		`{"id":"b","name":"lib b","offline":false,"extras":"off","scanning":true,"progress":7}]`
	if st, reply := do("GET", LibrariesPath, ""); st != 200 || reply != want {
		t.Fatalf("list: %d %s", st, reply)
	}
	for _, c := range []struct{ path, body string }{
		{LibrariesOfflinePath, `{"id":"a"}`},
		{LibrariesExtrasPath, `{"id":"a","on":true}`},
		{LibrariesRescanPath, `{"id":"a"}`},
	} {
		if st, reply := do("POST", c.path, c.body); st != 200 || reply != "{}" {
			t.Fatalf("%s: %d %s", c.path, st, reply)
		}
	}
	if st, reply := do("GET", LibrariesPath, ""); st != 200 ||
		!strings.HasPrefix(reply, `[{"id":"a","name":"lib a","offline":true,"extras":"on",`) {
		t.Fatalf("after the writes: %d %s", st, reply)
	}
	const refresh = "a?Recursive=true&MetadataRefreshMode=Default&ImageRefreshMode=Default"
	if len(f.refreshed) != 1 || f.refreshed[0] != refresh {
		t.Fatalf("refreshed %v", f.refreshed)
	}
	if st, reply := do("POST", LibrariesRescanPath, `{"id":"gone"}`); st != http.StatusBadGateway ||
		!strings.Contains(reply, `HTTP 404: Item not found.`) {
		t.Fatalf("a Jellyfin error: %d %s", st, reply)
	}
	for _, body := range []string{"", "{}", `{"id":1}`} {
		if st, _ := do("POST", LibrariesRescanPath, body); st != http.StatusBadRequest {
			t.Fatalf("bad body %q: %d", body, st)
		}
	}
}

// A Jellyfin the user brought: 409 (the web app tells it from a gateway too old, 404).
func TestLibrariesAPIUserJellyfin(t *testing.T) {
	_, srv := newFake(t, true)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	if err := s.Login(context.Background(), "me", "pw"); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ method, path, body string }{
		{"GET", LibrariesPath, ""},
		{"POST", LibrariesOfflinePath, `{"id":"a"}`},
		{"POST", LibrariesExtrasPath, `{"id":"a","on":true}`},
		{"POST", LibrariesRescanPath, `{"id":"a"}`},
	} {
		st, _, _, _ := tunnel.Do(libAPI(s), tunnel.Session{Role: tunnel.Admin}, c.method, c.path, c.body)
		if st != http.StatusConflict {
			t.Fatalf("%s %s: %d", c.method, c.path, st)
		}
	}
}
