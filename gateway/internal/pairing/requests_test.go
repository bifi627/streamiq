package pairing

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"streamiq/gateway/internal/tunnel"
)

// GET /streamiq/pairing/requests + POST /streamiq/pairing/decide (#956): admin-only, the list
// carries the requester's users.id, decide ends the exchange like the local page, an unknown id
// 404s.
func TestRequestsAPI(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	api := tunnel.NewRouter()
	api.Handle("GET "+RequestsPath, http.HandlerFunc(store.ServeRequests), tunnel.AdminOnly)
	api.Handle("POST "+DecidePath, http.HandlerFunc(store.ServeDecide), tunnel.AdminOnly)
	call := func(role, method, path, body string) (int, string) {
		s, _, reply, _ := tunnel.Do(api, tunnel.Session{Role: role, Key: "aa"}, method, path, body)
		return s, reply
	}
	if s, list := call(tunnel.Admin, "GET", RequestsPath, ""); s != 200 || list != "[]" {
		t.Fatalf("empty list: %d %s", s, list)
	}
	got := make(chan bool, 1)
	go func() { ok, _ := store.Ask("phone", "fp-1", "123456", "u1", nil); got <- ok }()
	for len(store.Pending()) == 0 {
		time.Sleep(time.Millisecond)
	}
	id := store.Pending()[0].ID

	for _, c := range [][2]string{{"GET", RequestsPath}, {"POST", DecidePath}} {
		if s, _ := call(tunnel.Member, c[0], c[1], `{"id":"`+id+`","approve":true}`); s != http.StatusForbidden {
			t.Errorf("member %s %s: %d, want 403", c[0], c[1], s)
		}
	}
	s, list := call(tunnel.Admin, "GET", RequestsPath, "")
	if s != 200 || !strings.Contains(list, `"id":"`+id+`","name":"phone","code":"123456","user":"u1","expires":"`) {
		t.Fatalf("list: %d %s", s, list)
	}
	if s, _ := call(tunnel.Admin, "POST", DecidePath, `{"id":"nope","approve":true}`); s != http.StatusNotFound {
		t.Errorf("unknown id: %d, want 404", s)
	}
	if s, _ := call(tunnel.Admin, "POST", DecidePath, `{}`); s != http.StatusBadRequest {
		t.Errorf("no id: %d, want 400", s)
	}
	if s, _ := call(tunnel.Admin, "POST", DecidePath, `{"id":"`+id+`","approve":true}`); s != 200 {
		t.Fatalf("approve: %d", s)
	}
	if !<-got || !store.Allowed("fp-1") {
		t.Error("approve did not pair the key")
	}
	if s, _ := call(tunnel.Admin, "POST", DecidePath, `{"id":"`+id+`","approve":true}`); s != http.StatusNotFound {
		t.Errorf("decided twice: %d, want 404", s)
	}
}
