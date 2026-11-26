package jellyfin

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const handWritten = `services:
  jellyfin:
    image: jellyfin/jellyfin:x
    networks: [jail]
    volumes:
    - ./jellyfin-config:/config
    - cache:/cache
    - D:\Movies:/media/movies:ro
    - "/srv/tv:/media/tv"
    - vol:/media/named
    # - E:\Old:/media/old:ro
    - type: bind
      # where the music is
      source: "D:\\My Music" # a comment
      target: '/media/my music'
      bind:
        create_host_path: false
    - type: volume
      source: vol2
      target: /media/vol2
  other:
    volumes:
      - /x:/media/x
volumes:
  cache:
`

func TestMounts(t *testing.T) {
	for name, tc := range map[string]struct {
		in   string
		want []Mount
	}{
		"shipped": {readFile(t, shipped), []Mount{{Source: "./media", Target: "/media/media"}}},
		"hand-written": {handWritten, []Mount{
			{Source: `D:\Movies`, Target: "/media/movies"},
			{Source: "/srv/tv", Target: "/media/tv", ReadWrite: true},
			{Source: `D:\My Music`, Target: "/media/my music", ReadWrite: true},
		}},
	} {
		for _, nl := range []string{"\n", "\r\n"} {
			got, err := Mounts([]byte(strings.ReplaceAll(tc.in, "\n", nl)))
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			var plain []Mount
			for _, m := range got {
				plain = append(plain, Mount{Source: m.Source, Target: m.Target, ReadWrite: m.ReadWrite})
			}
			if !slices.Equal(plain, tc.want) {
				t.Errorf("%s %q: %+v", name, nl, plain)
			}
		}
	}
}

// add → list → remove gives the file back byte for byte, LF and CRLF, and the
// new bind is the long form the shipped file uses, after its last media bind.
func TestAddRemoveRoundTrip(t *testing.T) {
	for in, pad := range map[string]string{readFile(t, shipped): "      ", handWritten: "    "} {
		for _, nl := range []string{"\n", "\r\n"} {
			orig := []byte(strings.ReplaceAll(in, "\n", nl))
			added, m, err := AddMount(orig, "/gw", `E:\My Films`, "")
			if err != nil || m.Target != "/media/My Films" {
				t.Fatalf("add: %+v, %v", m, err)
			}
			item := strings.Join([]string{"- type: bind", "  source: 'E:\\My Films'",
				"  target: '/media/My Films'", "  read_only: true"}, nl+pad)
			if !strings.Contains(string(added), nl+pad+item+nl) {
				t.Fatalf("add %q:\n%s", nl, added)
			}
			ms, _ := Mounts(added)
			if last := ms[len(ms)-1]; last.Source != `E:\My Films` || last.Target != m.Target || last.ReadWrite {
				t.Fatalf("list after add: %+v", ms)
			}
			for _, which := range []string{`E:\My Films`, "E:/My Films/", m.Target} {
				back, removed, err := RemoveMount(added, "/gw", which)
				if err != nil || len(removed) != 1 || !bytes.Equal(back, orig) {
					t.Fatalf("remove %q (%q): %v, %+v\n%s", which, nl, err, removed, back)
				}
			}
		}
	}
	// the shipped example comment stays below the new bind, outside the list
	added, _, _ := AddMount([]byte(readFile(t, shipped)), "/gw", "/srv/a", "")
	if !strings.Contains(string(added), "read_only: true\n      # - type: bind") {
		t.Fatalf("placement:\n%s", added)
	}
}

// $ is compose's interpolation: written as $$, read back as $.
func TestMountDollar(t *testing.T) {
	orig := []byte(readFile(t, shipped))
	added, m, err := AddMount(orig, "/gw", `C:\Users\$Media`, "")
	if err != nil || m.Target != "/media/$Media" ||
		!strings.Contains(string(added), "source: 'C:\\Users\\$$Media'\n        target: '/media/$$Media'\n") {
		t.Fatalf("%+v, %v\n%s", m, err, added)
	}
	if ms, _ := Mounts(added); ms[1].Source != `C:\Users\$Media` || ms[1].Target != "/media/$Media" {
		t.Fatalf("list: %+v", ms)
	}
	if _, _, err := AddMount(added, "/gw", `C:\Users\$Media`, "x"); err == nil {
		t.Fatal("mounted twice")
	}
	for _, which := range []string{`C:\Users\$Media`, "/media/$Media", "/media/$Media/"} {
		if back, _, err := RemoveMount(added, "/gw", which); err != nil || !bytes.Equal(back, orig) {
			t.Fatalf("remove %q: %v", which, err)
		}
	}
}

func TestAddMountNames(t *testing.T) {
	b := []byte(readFile(t, shipped))
	for _, tc := range []struct{ source, name, want string }{
		{"/srv/Films", "", "/media/Films"},
		{"/srv/media", "", "/media/media 2"},
		{`D:\`, "tv", "/media/tv"},
		{"/srv/x/", "", "/media/x"},
	} {
		if _, m, err := AddMount(b, "/gw", tc.source, tc.name); err != nil || m.Target != tc.want {
			t.Errorf("%q --as %q: %q, %v", tc.source, tc.name, m.Target, err)
		}
	}
	twice, _, _ := AddMount(b, "/gw", "/a/media", "")
	if _, m, _ := AddMount(twice, "/gw", "/b/media", ""); m.Target != "/media/media 3" {
		t.Errorf("third media: %q", m.Target)
	}
}

func TestAddMountRefused(t *testing.T) {
	b := []byte(readFile(t, shipped))
	for name, tc := range map[string]struct{ source, as string }{
		"mounted, relative in the file": {"/gw/media", ""},
		"mounted, other spelling":       {"/gw/./media/", "x"},
		"taken":                         {"/srv/a", "media"},
		"slash":                         {"/srv/a", "a/b"},
		"backslash":                     {"/srv/a", `a\b`},
		"dot dot":                       {"/srv/a", ".."},
		"newline":                       {"/srv/a", "a\nb"},
		"no base name":                  {`D:\`, ""},
	} {
		if out, _, err := AddMount(b, "/gw", tc.source, tc.as); err == nil || out != nil {
			t.Errorf("%s: no error", name)
		}
	}
}

func TestMountsUnknownShape(t *testing.T) {
	ship := readFile(t, shipped)
	for name, in := range map[string]string{
		"no jellyfin": strings.Replace(ship, "  jellyfin:", "  media:", 1),
		"no volumes":  strings.Replace(ship, "    volumes:", "    # volumes:", 1),
		"flow list":   strings.Replace(ship, "    volumes:", "    volumes: []", 1),
	} {
		if _, err := Mounts([]byte(in)); !errors.Is(err, errShape) {
			t.Errorf("%s: %v", name, err)
		}
		if _, _, err := AddMount([]byte(in), "/gw", "/srv/a", ""); !errors.Is(err, errShape) {
			t.Errorf("%s add: %v", name, err)
		}
		if _, _, err := RemoveMount([]byte(in), "/gw", "/media/media"); !errors.Is(err, errShape) {
			t.Errorf("%s remove: %v", name, err)
		}
	}
}

func TestRemoveMount(t *testing.T) {
	b := []byte(handWritten)
	out, removed, err := RemoveMount(b, "/gw", "/media/my music")
	if err != nil || len(removed) != 1 {
		t.Fatal(removed, err)
	}
	want := strings.Replace(handWritten, `    - type: bind
      # where the music is
      source: "D:\\My Music" # a comment
      target: '/media/my music'
      bind:
        create_host_path: false
`, "", 1)
	if string(out) != want {
		t.Fatalf("got\n%s", out)
	}
	for _, which := range []string{"/media/named", "/media/vol2", "/media/x", "/config", "/media/old", "/media/nope"} {
		if _, _, rerr := RemoveMount(b, "/gw", which); rerr == nil {
			t.Errorf("%s: removed", which)
		}
	}
	shipOut, _, err := RemoveMount([]byte(readFile(t, shipped)), "/gw", "/gw/media")
	if err != nil || strings.Contains(string(shipOut), "source: ./media") {
		t.Fatalf("shipped ./media: %v", err)
	}
}

// folderCLI: a compose file in a temp dir, Docker faked.
func folderCLI(t *testing.T, running bool, up error) (f FolderIO, out *bytes.Buffer, ups *int) {
	dir := t.TempDir()
	f = FolderIO{File: filepath.Join(dir, ComposeFile), Out: &bytes.Buffer{}, In: strings.NewReader("")}
	if err := os.WriteFile(f.File, []byte(readFile(t, shipped)), 0o644); err != nil {
		t.Fatal(err)
	}
	ups = new(int)
	r, c := jellyfinRunning, recreate
	t.Cleanup(func() { jellyfinRunning, recreate = r, c })
	jellyfinRunning = func(context.Context, string) bool { return running }
	recreate = func(context.Context, string) error { *ups++; return up }
	return f, f.Out.(*bytes.Buffer), ups
}

func TestFolderCLI(t *testing.T) {
	ctx := t.Context()
	folder := filepath.Join(t.TempDir(), "My Films")
	if err := os.Mkdir(folder, 0o755); err != nil {
		t.Fatal(err)
	}

	t.Run("declined", func(t *testing.T) {
		f, out, ups := folderCLI(t, true, nil)
		f.In = strings.NewReader("n\n")
		before := readFile(t, f.File)
		if err := FolderAdd(ctx, f, folder, ""); err != nil || readFile(t, f.File) != before || *ups != 0 {
			t.Fatalf("%v, %d ups", err, *ups)
		}
		for _, s := range []string{"read-only", "Jellyfin restarts: streams playing now stop", "Nothing changed"} {
			if !strings.Contains(out.String(), s) {
				t.Errorf("no %q in\n%s", s, out)
			}
		}
	})

	t.Run("add, list, remove on a running Jellyfin", func(t *testing.T) {
		f, out, ups := folderCLI(t, true, nil)
		before := readFile(t, f.File)
		f.In = strings.NewReader("y\n")
		if err := FolderAdd(ctx, f, folder, ""); err != nil || *ups != 1 {
			t.Fatalf("add: %v, %d ups\n%s", err, *ups, out)
		}
		out.Reset()
		if err := FolderList(f); err != nil || !strings.Contains(out.String(), folder) ||
			!strings.Contains(out.String(), "/media/My Films") {
			t.Fatalf("list: %v\n%s", err, out)
		}
		out.Reset()
		f.Yes = true
		if err := FolderRemove(ctx, f, "/media/My Films"); err != nil || *ups != 2 || readFile(t, f.File) != before {
			t.Fatalf("remove: %v, %d ups\n%s", err, *ups, out)
		}
		for _, s := range []string{"lose its titles", "No file is deleted", "Jellyfin restarts"} {
			if !strings.Contains(out.String(), s) {
				t.Errorf("no %q in\n%s", s, out)
			}
		}
		if _, err := os.Stat(folder); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("list says read-write", func(t *testing.T) {
		f, out, _ := folderCLI(t, false, nil)
		if err := os.WriteFile(f.File, []byte(handWritten), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := FolderList(f); err != nil || strings.Count(out.String(), "read-write") != 2 ||
			!slices.ContainsFunc(strings.Split(out.String(), "\n"), func(l string) bool {
				return slices.Equal(strings.Fields(l), []string{"/srv/tv", "/media/tv", "read-write"})
			}) {
			t.Fatalf("%v\n%s", err, out)
		}
	})

	t.Run("not running: written, applies at the next up", func(t *testing.T) {
		f, out, ups := folderCLI(t, false, nil)
		f.Yes = true
		t.Chdir(filepath.Dir(folder))
		if err := FolderAdd(ctx, f, "My Films", "films"); err != nil || *ups != 0 {
			t.Fatalf("%v, %d ups", err, *ups)
		}
		if !strings.Contains(out.String(), "next `gateway jellyfin up`") ||
			!strings.Contains(readFile(t, f.File), "source: '"+folder+"'") {
			t.Fatalf("relative path not stored absolute, or no hint:\n%s\n%s", out, readFile(t, f.File))
		}
	})

	t.Run("recreate fails: the old file back", func(t *testing.T) {
		f, _, _ := folderCLI(t, true, errors.New("docker down"))
		f.Yes = true
		before := readFile(t, f.File)
		if err := FolderAdd(ctx, f, folder, ""); err == nil || readFile(t, f.File) != before {
			t.Fatalf("%v", err)
		}
	})

	t.Run("refused: nothing written", func(t *testing.T) {
		f, _, ups := folderCLI(t, true, nil)
		f.Yes = true
		before := readFile(t, f.File)
		file := filepath.Join(folder, "..", "a file")
		if err := os.WriteFile(file, nil, 0o644); err != nil {
			t.Fatal(err)
		}
		for name, err := range map[string]error{
			"missing":    FolderAdd(ctx, f, filepath.Join(folder, "nope"), ""),
			"a file":     FolderAdd(ctx, f, file, ""),
			"bad --as":   FolderAdd(ctx, f, folder, "a/b"),
			"unknown rm": FolderRemove(ctx, f, "/media/nope"),
		} {
			if err == nil {
				t.Errorf("%s: no error", name)
			}
		}
		if readFile(t, f.File) != before || *ups != 0 {
			t.Fatal("written")
		}
	})

	t.Run("no compose file", func(t *testing.T) {
		f := FolderIO{File: filepath.Join(t.TempDir(), ComposeFile), Out: &bytes.Buffer{}, Yes: true}
		for _, err := range []error{
			FolderList(f), FolderAdd(ctx, f, folder, ""), FolderRemove(ctx, f, "/media/media"),
		} {
			if err == nil || !strings.Contains(err.Error(), "needs the Jellyfin from jellyfin-compose.yml") ||
				strings.Contains(err.Error(), "\n") {
				t.Errorf("%v", err)
			}
		}
	})
}
