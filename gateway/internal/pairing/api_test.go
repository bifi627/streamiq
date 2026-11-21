package pairing

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"streamiq/gateway/internal/tunnel"
)

// GET /streamiq/clients + POST /streamiq/clients/remove (#311) and /rename (#365): a member only its
// own key (#341), the list marks the caller's own key, remove 404s an unknown key, removes another
// client at once (closing its sessions via OnRemove) and the caller's own key
// only after the reply is delivered.
func TestClientsAPI(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "allowlist.json"), []byte(`[
		{"keyFp":"aa","name":"Phone","addedAt":"2026-11-01T10:00:00Z"},
		{"keyFp":"bb","name":"TV","addedAt":"2026-11-02T10:00:00Z"}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	var dropped []string
	store.OnRemove = func(fp string) { dropped = append(dropped, fp) }
	api := tunnel.NewRouter()
	api.Handle("GET "+ClientsPath, http.HandlerFunc(store.ServeClients))
	api.Handle("POST "+ClientsRemovePath, http.HandlerFunc(store.ServeRemove))
	api.Handle("POST "+ClientsRenamePath, http.HandlerFunc(store.ServeRename))
	call := func(role, method, path, body string) (int, string, func()) {
		s, _, reply, after := tunnel.Do(api, tunnel.Session{Role: role, Key: "aa"}, method, path, body)
		return s, reply, after
	}
	// A member (#341): sees only its own key, removing any other is 403 (known or not).
	if s, list, _ := call(
		tunnel.Member,
		"GET",
		ClientsPath,
		"",
	); s != 200 ||
		list != `[{"keyFp":"aa","name":"Phone","addedAt":"2026-11-01T10:00:00Z","self":true}]` {
		t.Fatalf("member list: %d %s", s, list)
	}
	for _, fp := range []string{"bb", "zz"} {
		if s, _, _ := call(
			tunnel.Member,
			"POST",
			ClientsRemovePath,
			`{"keyFp":"`+fp+`"}`,
		); s != http.StatusForbidden ||
			!store.Allowed("bb") {
			t.Errorf("member removes %s: %d, want 403", fp, s)
		}
	}
	code, list, _ := call(tunnel.Admin, "GET", ClientsPath, "")
	want := `[{"keyFp":"aa","name":"Phone","addedAt":"2026-11-01T10:00:00Z","self":true},{"keyFp":"bb","name":"TV","addedAt":"2026-11-02T10:00:00Z","self":false}]`
	if code != 200 || list != want {
		t.Fatalf("list: %d %s", code, list)
	}
	// Rename (#365): same access as remove, the name rule of /streamiq/name, saved.
	for _, fp := range []string{"bb", "zz"} {
		if s, _, _ := call(
			tunnel.Member,
			"POST",
			ClientsRenamePath,
			`{"keyFp":"`+fp+`","name":"Mine"}`,
		); s != http.StatusForbidden {
			t.Errorf("member renames %s: %d, want 403", fp, s)
		}
	}
	for body, want := range map[string]int{
		`{"keyFp":"zz","name":"X"}`:                               http.StatusNotFound,
		`{"keyFp":"bb","name":"  "}`:                              http.StatusBadRequest,
		`{"keyFp":"bb","name":"a\u0000b"}`:                        http.StatusBadRequest,
		`{"keyFp":"bb","name":"` + strings.Repeat("😀", 51) + `"}`: http.StatusBadRequest,
		`{"name":"X"}`: http.StatusBadRequest,
		`nope`:         http.StatusBadRequest,
	} {
		if s, _, _ := call(tunnel.Admin, "POST", ClientsRenamePath, body); s != want {
			t.Errorf("rename %s: %d, want %d", body, s, want)
		}
	}
	if s, out, _ := call(
		tunnel.Member,
		"POST",
		ClientsRenamePath,
		`{"keyFp":"aa","name":" Anna's phone "}`,
	); s != 200 ||
		out != `{"name":"Anna's phone"}` {
		t.Fatalf("member renames own: %d %s", s, out)
	}
	if s, out, _ := call(
		tunnel.Admin,
		"POST",
		ClientsRenamePath,
		`{"keyFp":"bb","name":"Living room TV"}`,
	); s != 200 ||
		out != `{"name":"Living room TV"}` {
		t.Fatalf("admin renames other: %d %s", s, out)
	}
	if again, _ := Open(
		dir,
	); fmt.Sprint(
		again.Paired()[0].Name,
		"|",
		again.Paired()[1].Name,
	) != "Anna's phone|Living room TV" {
		t.Fatalf("not saved: %v", again.Paired())
	}
	if s, _, _ := call(tunnel.Admin, "POST", ClientsRemovePath, `{"keyFp":"zz"}`); s != http.StatusNotFound {
		t.Errorf("unknown key: %d, want 404", s)
	}
	if s, _, _ := call(tunnel.Admin, "POST", ClientsRemovePath, `nope`); s != http.StatusBadRequest {
		t.Errorf("bad body: %d, want 400", s)
	}
	// Another client: gone at once, its sessions closed.
	if s, _, _ := call(
		tunnel.Admin,
		"POST",
		ClientsRemovePath,
		`{"keyFp":"bb"}`,
	); s != 200 || store.Allowed("bb") ||
		!slices.Equal(dropped, []string{"bb"}) {
		t.Fatalf("remove other: %d allowed=%v dropped=%v", s, store.Allowed("bb"), dropped)
	}
	// The caller itself (Key "aa", here a member): only after the reply is delivered.
	s, _, after := call(tunnel.Member, "POST", ClientsRemovePath, `{"keyFp":"aa"}`)
	if s != 200 || !store.Allowed("aa") || len(dropped) != 1 {
		t.Fatalf("remove self: %d, before the reply is out: allowed=%v dropped=%v", s, store.Allowed("aa"), dropped)
	}
	after() // handleReq: once the reply is delivered
	if store.Allowed("aa") || !slices.Equal(dropped, []string{"bb", "aa"}) {
		t.Fatalf("after: allowed aa=%v, dropped=%v", store.Allowed("aa"), dropped)
	}
}

// Removing the calling client (#520): a failed save after the reply is logged,
// a successful one logs nothing.
func TestRemoveSelfLogsFailedSave(t *testing.T) {
	var buf strings.Builder
	defer log.SetOutput(log.Writer())
	log.SetOutput(&buf)
	dir := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(dir, "allowlist.json"),
		[]byte(`[{"keyFp":"aa","name":"Phone"},{"keyFp":"bb","name":"TV"}]`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	store, _ := Open(dir)
	api := tunnel.NewRouter()
	api.Handle("POST "+ClientsRemovePath, http.HandlerFunc(store.ServeRemove))
	remove := func(fp string) {
		_, _, _, after := tunnel.Do(
			api,
			tunnel.Session{Role: tunnel.Admin, Key: fp},
			"POST",
			ClientsRemovePath,
			`{"keyFp":"`+fp+`"}`,
		)
		after()
	}
	remove("aa")
	if buf.Len() != 0 || store.Allowed("aa") {
		t.Fatalf("saved self-removal: allowed=%v, logged %q", store.Allowed("aa"), buf.String())
	}
	os.Remove(filepath.Join(dir, "allowlist.json"))
	// the save can't write a directory
	if err := os.Mkdir(filepath.Join(dir, "allowlist.json"), 0o700); err != nil {
		t.Fatal(err)
	}
	remove("bb")
	if !strings.Contains(buf.String(), "gateway: remove client:") || store.Allowed("bb") {
		t.Fatalf("failed save: allowed=%v, logged %q", store.Allowed("bb"), buf.String())
	}
}
