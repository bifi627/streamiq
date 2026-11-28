package tags

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"streamiq/gateway/internal/tunnel"
)

const item1, item2 = "0123456789abcdef0123456789abcdef", "fedcba98-7654-3210-fedc-ba9876543210"

func api(s *Store) *tunnel.Router {
	rt := tunnel.NewRouter()
	rt.Handle("GET "+TagsPath, http.HandlerFunc(s.ServeList))
	rt.Handle("PUT "+TagsPath+"/{itemId}", http.HandlerFunc(s.ServeSet))
	return rt
}

var member = tunnel.Session{User: "u2", Role: tunnel.Member}

func put(t *testing.T, rt *tunnel.Router, id, body string) int {
	t.Helper()
	status, _, _, _ := tunnel.Do(rt, member, "PUT", TagsPath+"/"+id, body)
	return status
}

func list(t *testing.T, rt *tunnel.Router) []Tag {
	t.Helper()
	status, _, reply, _ := tunnel.Do(rt, member, "GET", TagsPath, "")
	var out []Tag
	if status != http.StatusOK || json.Unmarshal([]byte(reply), &out) != nil {
		t.Fatalf("GET: %d %s", status, reply)
	}
	return out
}

func load(t *testing.T, dir string) *Store {
	t.Helper()
	s, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestTagsAreListedWithTheirItemsAndSurviveARestart(t *testing.T) {
	dir := t.TempDir()
	rt := api(load(t, dir))
	if s := put(t, rt, item1, `{"tags":[" funny ","Cozy","FUNNY"]}`); s != http.StatusNoContent {
		t.Fatalf("put: %d", s)
	}
	put(t, rt, item2, `{"tags":["funny"]}`)
	want := `[{"name":"Cozy","itemIds":["` + item1 + `"]},{"name":"funny","itemIds":["` + item1 + `","` + item2 + `"]}]`
	for _, rt := range []*tunnel.Router{rt, api(load(t, dir))} { // the second: after a restart
		if got, _ := json.Marshal(list(t, rt)); string(got) != want {
			t.Fatalf("got %s\nwant %s", got, want)
		}
	}
	put(t, rt, item1, `{"tags":[]}`)
	if got := list(t, rt); len(got) != 1 || len(got[0].ItemIDs) != 1 || got[0].ItemIDs[0] != item2 {
		t.Fatalf("after removing item1: %+v", got)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, File)); strings.Contains(string(b), item1) {
		t.Fatalf("item1 still in the file: %s", b)
	}
}

func TestABadPutIsRefusedAndChangesNothing(t *testing.T) {
	rt := api(load(t, t.TempDir()))
	put(t, rt, item1, `{"tags":["keep"]}`)
	many := make([]string, MaxPerItem+1)
	for i := range many {
		many[i] = strings.Repeat("a", i+1)
	}
	tooMany, _ := json.Marshal(SetTags{Tags: many})
	for _, c := range []struct{ id, body string }{
		{"../x", `{"tags":["a"]}`},
		{item1 + "abcde", `{"tags":["a"]}`},
		{item1, ``},
		{item1, `{}`},
		{item1, `{"tags":"a"}`},
		{item1, `{"tags":["  "]}`},
		{item1, `{"tags":["` + strings.Repeat("x", MaxLen+1) + `"]}`},
		{item1, string(tooMany)},
	} {
		want := http.StatusBadRequest
		if c.id == "../x" {
			want = http.StatusNotFound // the router's: an unclean path is never routed
		}
		if s := put(t, rt, c.id, c.body); s != want {
			t.Errorf("%s %q: %d", c.id, c.body, s)
		}
	}
	if got := list(t, rt); len(got) != 1 || got[0].Name != "keep" {
		t.Fatalf("changed: %+v", got)
	}
}

func TestTheLimitsHoldAtTheirEdge(t *testing.T) {
	rt := api(load(t, t.TempDir()))
	twenty := make([]string, MaxPerItem)
	for i := range twenty {
		twenty[i] = strings.Repeat("é", MaxLen-i) // runes, not bytes
	}
	b, _ := json.Marshal(SetTags{Tags: append(twenty, "É"+strings.Repeat("é", MaxLen-1))}) // a duplicate: still 20
	if s := put(t, rt, item1, string(b)); s != http.StatusNoContent {
		t.Fatalf("20 tags of up to %d characters: %d", MaxLen, s)
	}
	if got := list(t, rt); len(got) != MaxPerItem {
		t.Fatalf("%d tags", len(got))
	}
}

func TestConcurrentPutsKeepTheFileWhole(t *testing.T) {
	dir := t.TempDir()
	rt := api(load(t, dir))
	ids := []string{item1, item2, "00000000000000000000000000000001", "00000000000000000000000000000002"}
	var wg sync.WaitGroup
	for i := range 40 {
		wg.Go(func() { put(t, rt, ids[i%len(ids)], `{"tags":["t`+string(rune('a'+i%26))+`"]}`) })
	}
	wg.Wait()
	if got := load(t, dir); len(got.m) != len(ids) {
		t.Fatalf("items %v", got.m)
	}
}

func TestMembersAndAdminsMaySetTags(t *testing.T) {
	rt := api(load(t, t.TempDir()))
	for _, who := range []tunnel.Session{member, {User: "u1", Role: tunnel.Admin}} {
		if s, _, _, _ := tunnel.Do(rt, who, "PUT", TagsPath+"/"+item1, `{"tags":["a"]}`); s != http.StatusNoContent {
			t.Errorf("%s: %d", who.Role, s)
		}
	}
}
