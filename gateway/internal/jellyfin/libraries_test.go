package jellyfin

import (
	"context"
	"encoding/json"
	"maps"
	"testing"
)

// person is the fake's Person entry(s) in MetadataOptions.
func (f *fake) person(t *testing.T) map[string]any {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	var found []map[string]any
	for _, o := range f.cfg["MetadataOptions"].([]any) {
		if m := o.(map[string]any); m["ItemType"] == "Person" {
			found = append(found, m)
		}
	}
	if len(found) != 1 {
		t.Fatalf("%d Person entries in %v", len(found), f.cfg)
	}
	return found[0]
}

func tmdbOnly(v any) bool { b, _ := json.Marshal(v); return string(b) == `["TheMovieDb"]` }

// The server step (#322): TMDb off for people, no plugin repositories, the
// rest of the config kept, applied once, also to a managed Jellyfin from
// before it (only that step runs there).
func TestServerStep(t *testing.T) {
	f, srv := newFake(t, false)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	s.poll(context.Background())
	p := f.person(t)
	if !tmdbOnly(p["DisabledMetadataFetchers"]) || !tmdbOnly(p["DisabledImageFetchers"]) || f.cfg["ServerName"] != "keep me" ||
		len(f.cfg["PluginRepositories"].([]any)) != 0 || len(f.cfg["MetadataOptions"].([]any)) != 2 || f.cfgPosts != 1 {
		t.Fatalf("after bootstrap: %d posts, %v", f.cfgPosts, f.cfg)
	}
	f.mu.Lock()
	f.cfg["PluginRepositories"] = []any{"added in the Dashboard"}
	f.mu.Unlock()
	s.poll(context.Background())
	if f.cfgPosts != 1 || len(f.cfg["PluginRepositories"].([]any)) != 1 {
		t.Fatalf("applied again: %d posts, %v", f.cfgPosts, f.cfg)
	}

	// A managed Jellyfin from before the step, with a Person entry of its own.
	f.mu.Lock()
	f.cfg["MetadataOptions"] = []any{map[string]any{"ItemType": "Person", "DisabledMetadataFetchers": []any{}, "MetadataFetcherOrder": []any{"x"}}}
	encPosts := f.encPosts
	f.mu.Unlock()
	c := s.creds
	c.ServerSteps = 0
	if err := s.save(c); err != nil {
		t.Fatal(err)
	}
	s.poll(context.Background())
	p = f.person(t)
	if !tmdbOnly(p["DisabledMetadataFetchers"]) || !tmdbOnly(p["DisabledImageFetchers"]) || p["MetadataFetcherOrder"] == nil ||
		f.cfgPosts != 2 || f.encPosts != encPosts || s.creds.ServerSteps != len(serverSteps) {
		t.Fatalf("existing Jellyfin: %d/%d posts, %v, creds %+v", f.cfgPosts, f.encPosts, f.cfg, s.creds)
	}
}

func lib(id, contentType string, typeOptions []any, extrasOn ...bool) map[string]any {
	o := map[string]any{"SeasonZeroDisplayName": "Specials", "TypeOptions": typeOptions}
	for i, on := range extrasOn {
		o[extras[i]] = on
	}
	l := map[string]any{"Name": "lib " + id, "ItemId": id, "LibraryOptions": o}
	if contentType != "" {
		l["CollectionType"] = contentType
	}
	return l
}

func typeOpt(typ string, md, img []any) map[string]any {
	return map[string]any{"Type": typ, "MetadataFetchers": md, "ImageFetchers": img, "ImageOptions": []any{"keep me"}}
}

// Offline and Extras are read from Jellyfin, never stored (#322).
func TestLibraryState(t *testing.T) {
	f, srv := newFake(t, false)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	s.poll(context.Background())
	off := typeOpt("Movie", []any{}, []any{})
	f.mu.Lock()
	f.libs = []map[string]any{
		lib("empty", "movies", []any{}), // missing entry: every fetcher on
		lib("off", "movies", []any{off}, true, true, true, true, true),
		lib("grabber", "movies", []any{typeOpt("Movie", []any{}, []any{"Screen Grabber"})}, true, false), // a grabbed frame shows the content
		lib("mixed", "", []any{off}),                                                                     // Series, Season, Episode missing
	}
	f.mu.Unlock()
	libs, err := s.Libraries(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []Library{{"empty", "lib empty", false, "Off"}, {"off", "lib off", true, "On"}, {"grabber", "lib grabber", false, "Custom"},
		{"mixed", "lib mixed", false, "Off"}}
	if len(libs) != len(want) {
		t.Fatalf("got %+v", libs)
	}
	for i := range want {
		if libs[i] != want[i] {
			t.Errorf("got %+v, want %+v", libs[i], want[i])
		}
	}
	for _, u := range f.tokens {
		if u != ViewerName {
			t.Fatalf("a %s session lingers", u)
		}
	}
}

// Each button changes only its own fields, of its own library.
func TestLibraryWrites(t *testing.T) {
	f, srv := newFake(t, false)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	s.poll(context.Background())
	ctx := context.Background()
	f.mu.Lock()
	f.libs = []map[string]any{lib("a", "", []any{typeOpt("Movie", []any{"TheMovieDb"}, []any{"Screen Grabber"})}, true, false, true),
		lib("b", "movies", []any{})}
	b, _ := json.Marshal(f.libs)
	var orig []map[string]any
	json.Unmarshal(b, &orig)
	f.mu.Unlock()
	opts := func(i int) map[string]any {
		f.mu.Lock()
		defer f.mu.Unlock()
		b, _ := json.Marshal(f.libs[i]["LibraryOptions"])
		var m map[string]any
		json.Unmarshal(b, &m)
		return m
	}

	if err := s.MakeOffline(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	a, origA := opts(0), orig[0]["LibraryOptions"].(map[string]any)
	tos := a["TypeOptions"].([]any)
	if len(tos) != 4 || !offline(a, []string{"Movie", "Series", "Season", "Episode"}) || tos[0].(map[string]any)["ImageOptions"] == nil {
		t.Fatalf("make offline: %v", a)
	}
	delete(a, "TypeOptions")
	delete(origA, "TypeOptions")
	if !maps.EqualFunc(a, origA, func(x, y any) bool { return x == y }) {
		t.Fatalf("make offline changed other fields: %v, was %v", a, origA)
	}

	if err := s.SetExtras(ctx, "a", true); err != nil {
		t.Fatal(err)
	}
	a = opts(0)
	if extrasState(a) != "On" || !offline(a, []string{"Movie", "Series", "Season", "Episode"}) || a["SeasonZeroDisplayName"] != "Specials" {
		t.Fatalf("extras on: %v", a)
	}
	if err := s.SetExtras(ctx, "a", false); err != nil || extrasState(opts(0)) != "Off" {
		t.Fatalf("extras off: %v %v", err, opts(0))
	}
	if bo, _ := json.Marshal(opts(1)); string(bo) != mustJSON(orig[1]["LibraryOptions"]) {
		t.Fatalf("another library changed: %s", bo)
	}
	if err := s.MakeOffline(ctx, "gone"); err == nil || f.libPosts != 3 {
		t.Fatalf("unknown library: %v, %d posts", err, f.libPosts)
	}
}

func mustJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

// A Jellyfin the user brought: no list, no writes.
func TestLibrariesUserJellyfin(t *testing.T) {
	f, srv := newFake(t, true)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	if err := s.Login(context.Background(), "me", "pw"); err != nil {
		t.Fatal(err)
	}
	f.libs = []map[string]any{lib("a", "movies", []any{})}
	if _, err := s.Libraries(context.Background()); err == nil {
		t.Fatal("listed a user's libraries")
	}
	if err := s.SetExtras(context.Background(), "a", true); err == nil || f.libPosts != 0 {
		t.Fatalf("changed a user's library: %v", err)
	}
}
