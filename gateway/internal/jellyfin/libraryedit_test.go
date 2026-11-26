package jellyfin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"testing"

	"streamiq/gateway/internal/tunnel"
)

// libraryEdit is the fake's library writes and folder listing, like Jellyfin's
// (by name; a missing folder or library is 400 / 404). Called under f.mu, as admin.
func (f *fake) libraryEdit(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("refreshLibrary") == "true" {
		f.refreshed = append(f.refreshed, "scan")
	}
	byName := slices.IndexFunc(f.libs, func(l map[string]any) bool { return l["Name"] == q.Get("name") })
	switch r.Method + " " + r.URL.Path {
	case "GET /Environment/DirectoryContents":
		var out []map[string]any
		for _, d := range f.dirs {
			out = append(out, map[string]any{"Name": d[strings.LastIndex(d, "/")+1:], "Path": d, "Type": "Directory"})
		}
		_ = json.NewEncoder(w).Encode(out)
	case "POST /Library/VirtualFolders":
		var b struct{ LibraryOptions map[string]any }
		if json.NewDecoder(r.Body).Decode(&b) != nil || byName >= 0 {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		var locs []any
		for _, p := range b.LibraryOptions["PathInfos"].([]any) {
			locs = append(locs, p.(map[string]any)["Path"])
		}
		b.LibraryOptions["SeasonZeroDisplayName"] = "Specials" // Jellyfin's defaults fill the rest
		f.libs = append(f.libs, map[string]any{"Name": q.Get("name"), "ItemId": "id-" + q.Get("name"),
			"CollectionType": q.Get("collectionType"), "Locations": locs, "LibraryOptions": b.LibraryOptions})
	case "DELETE /Library/VirtualFolders":
		if byName < 0 {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		f.libs = slices.Delete(f.libs, byName, byName+1)
	case "POST /Library/VirtualFolders/Paths":
		var b struct {
			Name     string
			PathInfo struct{ Path string }
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		i := slices.IndexFunc(f.libs, func(l map[string]any) bool { return l["Name"] == b.Name })
		if i < 0 || !slices.Contains(f.dirs, b.PathInfo.Path) {
			http.Error(w, "The path does not exist.", http.StatusBadRequest)
			return
		}
		f.libs[i]["Locations"] = append(f.libs[i]["Locations"].([]any), b.PathInfo.Path)
	case "DELETE /Library/VirtualFolders/Paths":
		if byName < 0 {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		f.libs[byName]["Locations"] = slices.DeleteFunc(f.libs[byName]["Locations"].([]any),
			func(p any) bool { return p == q.Get("path") })
	}
}

func editAPI(s *Setup) *tunnel.Router {
	rt := libAPI(s)
	rt.Handle("GET "+LibrariesFoldersPath, http.HandlerFunc(s.ServeFolders))
	rt.Handle("POST "+LibrariesCreatePath, http.HandlerFunc(s.ServeCreate))
	rt.Handle("POST "+LibrariesFolderAddPath, http.HandlerFunc(s.ServeFolderAdd))
	rt.Handle("POST "+LibrariesFolderRemovePath, http.HandlerFunc(s.ServeFolderRemove))
	rt.Handle("POST "+LibrariesRemovePath, http.HandlerFunc(s.ServeRemove))
	return rt
}

// #430: the folder list, a library created offline from it, a folder added
// and removed (never the last), the library removed.
func TestLibraryEditAPI(t *testing.T) {
	f, srv := newFake(t, false)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	s.poll(context.Background())
	f.mu.Lock()
	f.dirs = []string{"/media/shows", "/media/more", "/elsewhere/x"}
	f.mu.Unlock()
	rt := editAPI(s)
	do := func(method, url, body string) (int, string) {
		t.Helper()
		st, _, reply, _ := tunnel.Do(rt, tunnel.Session{Role: tunnel.Admin}, method, url, body)
		return st, reply
	}
	ok := func(path, body string) {
		t.Helper()
		if st, reply := do("POST", path, body); st != 200 || reply != "{}" {
			t.Fatalf("%s %s: %d %s", path, body, st, reply)
		}
	}
	list := func() []Library {
		t.Helper()
		_, reply := do("GET", LibrariesPath, "")
		var l []Library
		if err := json.Unmarshal([]byte(reply), &l); err != nil {
			t.Fatalf("%v: %s", err, reply)
		}
		return l
	}

	ok(LibrariesCreatePath, `{"name":" Shows ","type":"tvshows","folders":["/media/shows/"]}`)
	l := list()
	if len(l) != 1 || l[0].Name != "Shows" || l[0].Type != "tvshows" || !l[0].Offline || l[0].Extras != "off" ||
		!slices.Equal(l[0].Folders, []string{"/media/shows"}) {
		t.Fatalf("created: %+v", l)
	}
	if st, reply := do("GET", LibrariesFoldersPath, ""); st != 200 ||
		reply != `[{"path":"/media/shows","libraries":["Shows"]},{"path":"/media/more","libraries":[]}]` {
		t.Fatalf("folders: %d %s", st, reply)
	}
	id := l[0].ID
	ok(LibrariesFolderAddPath, `{"id":"`+id+`","folder":"/media/more"}`)
	if l = list(); !slices.Equal(l[0].Folders, []string{"/media/shows", "/media/more"}) {
		t.Fatalf("folder added: %+v", l)
	}
	ok(LibrariesFolderRemovePath, `{"id":"`+id+`","folder":"/media/shows"}`)
	if l = list(); !slices.Equal(l[0].Folders, []string{"/media/more"}) {
		t.Fatalf("folder removed: %+v", l)
	}
	for _, c := range []struct{ path, body, msg string }{
		{LibrariesFolderRemovePath, `{"id":"` + id + `","folder":"/media/more"}`, "remove the library instead"},
		{LibrariesFolderAddPath, `{"id":"` + id + `","folder":"/media/more"}`, "already in"},
		{LibrariesFolderAddPath, `{"id":"` + id + `","folder":"/media/../elsewhere"}`, "not a folder in /media"},
		{LibrariesFolderAddPath, `{"id":"` + id + `","folder":"/media/more/sub"}`, "not a folder in /media"},
		{LibrariesFolderAddPath, `{"id":"` + id + `","folder":"/media"}`, "not a folder in /media"},
		{LibrariesCreatePath, `{"name":"shows","type":"movies","folders":["/media/more"]}`, "already a library"},
		{LibrariesCreatePath, `{"name":"other","type":"movies","folders":["/media/more"]}`, "already in Shows: Jellyfin keeps"},
		{LibrariesCreatePath, `{"name":"x","type":"music","folders":["/media/more"]}`, "Unknown library type"},
		{LibrariesCreatePath, `{"name":"x","type":"movies","folders":[]}`, "at least one folder"},
		{LibrariesCreatePath, `{"name":" ","type":"movies","folders":["/media/more"]}`, "a name"},
		{LibrariesCreatePath, `{"name":"x","type":"movies","folders":["/elsewhere/x"]}`, "not a folder in /media"},
	} {
		if st, reply := do("POST", c.path, c.body); st != http.StatusBadRequest || !strings.Contains(reply, c.msg) {
			t.Errorf("%s %s: %d %s", c.path, c.body, st, reply)
		}
	}
	ok(LibrariesRemovePath, `{"id":"`+id+`"}`)
	if l = list(); len(l) != 0 {
		t.Fatalf("removed: %+v", l)
	}
	if want := []string{"scan", "scan", "scan", "scan"}; !slices.Equal(f.refreshed, want) {
		t.Fatalf("scans %v, want one per write", f.refreshed)
	}
	if st, reply := do("POST", LibrariesRemovePath, `{"id":"gone"}`); st != http.StatusBadGateway ||
		!strings.Contains(reply, "library not found") {
		t.Fatalf("an unknown id: %d %s", st, reply)
	}
	for _, c := range []struct{ path, body string }{
		{LibrariesFolderAddPath, `{"folder":"/media/more"}`},
		{LibrariesRemovePath, `{}`},
		{LibrariesCreatePath, `nope`},
	} {
		if st, _ := do("POST", c.path, c.body); st != http.StatusBadRequest {
			t.Errorf("bad body %s %s: %d", c.path, c.body, st)
		}
	}
}

// A created library's TypeOptions name every type with no fetcher at all.
func TestCreateOffline(t *testing.T) {
	f, srv := newFake(t, false)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	s.poll(context.Background())
	if err := s.CreateLibrary(context.Background(),
		NewLibrary{Name: "M", Type: "movies", Folders: []string{"/media/m"}}); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(f.libs[0]["LibraryOptions"])
	const want = `"TypeOptions":[{"ImageFetchers":[],"MetadataFetchers":[],"Type":"Movie"}]`
	if !strings.Contains(string(b), want) || strings.Contains(string(b), "true") {
		t.Fatalf("options %s", b)
	}
}

// A library on /media holds every /media/<name>: Jellyfin would skip the
// folder as a duplicate, so it lists as in use and is refused.
func TestFolderInUse(t *testing.T) {
	f, srv := newFake(t, false)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	s.poll(context.Background())
	f.mu.Lock()
	f.dirs = []string{"/media/a"}
	f.libs = []map[string]any{lib("root", "movies", []any{}), lib("x", "movies", []any{})}
	f.libs[0]["Locations"] = []any{"/media/"} // Jellyfin may keep a trailing slash
	f.mu.Unlock()
	fs, err := s.MediaFolders(context.Background())
	if err != nil || len(fs) != 1 || !slices.Equal(fs[0].Libraries, []string{"lib root"}) {
		t.Fatalf("folders: %+v, %v", fs, err)
	}
	var bad badRequest
	if err := s.AddFolder(context.Background(), "x", "/media/a"); !errors.As(err, &bad) {
		t.Fatalf("add: %v", err)
	}
	err = s.CreateLibrary(context.Background(), NewLibrary{Name: "n", Type: "movies", Folders: []string{"/media/a"}})
	if !errors.As(err, &bad) || !strings.Contains(err.Error(), "already in lib root") {
		t.Fatalf("create: %v", err)
	}
	if n := usedBy([]folder{{Name: "m", Locations: []string{"/media/ab"}}}, "/media/a"); len(n) != 0 {
		t.Fatal("/media/ab holds /media/a")
	}
}
