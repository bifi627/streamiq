package backup

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"testing/iotest"
	"time"
)

var state = map[string]string{
	"cert.pem":       "CERT",
	"gateway.json":   `{"gatewayId":"g1","credential":"c","name":"Living room"}`,
	"allowlist.json": `[]`,
	"jellyfin.json":  `{}`,
	"page-token":     "tok",
	"page-link":      "http://x/?t=tok",
}

func writeDir(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for n, s := range files {
		if err := os.WriteFile(filepath.Join(dir, n), []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func readDir(t *testing.T, dir string) map[string]string {
	t.Helper()
	got := map[string]string{}
	es, _ := os.ReadDir(dir)
	for _, e := range es {
		b, _ := os.ReadFile(filepath.Join(dir, e.Name()))
		got[e.Name()] = string(b)
	}
	return got
}

func backupFile(t *testing.T, dir string) string {
	t.Helper()
	var buf bytes.Buffer
	if err := Write(dir, filepath.Join(dir, "no-compose.yml"), "", &buf); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "b.zip")
	if err := os.WriteFile(p, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func zipOf(t *testing.T, names ...string) string {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, n := range names {
		w, _ := zw.Create(n)
		_, _ = w.Write([]byte("x")) // fails only for a directory entry ("dir/"), which takes no data
	}
	zw.Close()
	p := filepath.Join(t.TempDir(), "z.zip")
	if err := os.WriteFile(p, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRoundTrip(t *testing.T) {
	src := writeDir(t, state)
	// only regular files go in
	if err := os.Mkdir(filepath.Join(src, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(t.TempDir(), "state")
	if _, err := Restore(backupFile(t, src), dst, filepath.Join(t.TempDir(), "c.yml"), false); err != nil {
		t.Fatal(err)
	}
	want := maps.Clone(state)
	delete(want, "page-token")
	delete(want, "page-link")
	if got := readDir(t, dst); !maps.Equal(got, want) {
		t.Fatalf("restored %v, want %v", got, want)
	}
}

func TestRefusesExistingWithoutForce(t *testing.T) {
	zipPath := backupFile(t, writeDir(t, state))
	dst := writeDir(t, map[string]string{"gateway.json": `{"name":"other"}`, "metadata.json": "{}"})
	_, err := Restore(zipPath, dst, "", false)
	if err == nil || !strings.Contains(err.Error(), "gateway.json") || !strings.Contains(err.Error(), "--force") {
		t.Fatalf("err = %v, want a refusal naming gateway.json and --force", err)
	}
	if readDir(t, dst)["gateway.json"] != `{"name":"other"}` {
		t.Fatal("refused restore changed the state dir")
	}
	if _, err := Restore(zipPath, dst, "", true); err != nil {
		t.Fatal(err)
	}
	got := readDir(t, dst)
	if got["gateway.json"] != state["gateway.json"] {
		t.Fatal("--force did not overwrite")
	}
	if _, ok := got["metadata.json"]; ok {
		t.Fatal("--force kept the old gateway's file the backup doesn't have")
	}
}

func TestRejectsBadEntries(t *testing.T) {
	for _, bad := range []string{"install/other.yml", "install/../x", "../evil", "sub/x", `sub\x`, "/abs", "C:x", "dir/", "..", "."} {
		dst := filepath.Join(t.TempDir(), "state")
		if _, err := Restore(zipOf(t, "cert.pem", "gateway.json", bad), dst, "", false); err == nil {
			t.Errorf("%q: accepted", bad)
		}
		if _, err := os.Stat(dst); err == nil {
			t.Errorf("%q: wrote the state dir before rejecting", bad)
		}
	}
	if _, err := Restore(zipOf(t, "cert.pem"), t.TempDir(), "", false); err == nil {
		t.Error("zip without gateway.json accepted")
	}
}

func TestCompose(t *testing.T) {
	src := writeDir(t, state)
	compose := filepath.Join(t.TempDir(), "jellyfin-compose.yml")
	if err := os.WriteFile(compose, []byte("services: {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := Write(src, compose, "", &buf); err != nil {
		t.Fatal(err)
	}
	zipPath := filepath.Join(t.TempDir(), "b.zip")
	if err := os.WriteFile(zipPath, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}

	// Empty install dir: written next to the binary, not into state/.
	dst, into := filepath.Join(t.TempDir(), "state"), filepath.Join(t.TempDir(), "jellyfin-compose.yml")
	did, err := Restore(zipPath, dst, into, false)
	if err != nil || did != ComposeWritten {
		t.Fatalf("did %q, err %v", did, err)
	}
	if b, _ := os.ReadFile(into); string(b) != "services: {}" {
		t.Fatalf("compose = %q", b)
	}
	if _, err := os.Stat(filepath.Join(dst, "install")); err == nil {
		t.Fatal("compose entry went into the state dir")
	}

	// An existing compose file is the user's: kept, also with --force.
	if err := os.WriteFile(into, []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, force := range []bool{false, true} {
		did, err := Restore(zipPath, filepath.Join(t.TempDir(), "state"), into, force)
		if err != nil || did != ComposeKept {
			t.Fatalf("force=%v: did %q, err %v", force, did, err)
		}
		if b, _ := os.ReadFile(into); string(b) != "mine" {
			t.Fatalf("force=%v overwrote the compose file", force)
		}
	}

	// A zip without it (also every zip from before #297) restores, writes nothing.
	none := filepath.Join(t.TempDir(), "jellyfin-compose.yml")
	did, err = Restore(zipOf(t, "cert.pem", "gateway.json"), filepath.Join(t.TempDir(), "state"), none, false)
	if err != nil || did != ComposeNone {
		t.Fatalf("did %q, err %v", did, err)
	}
	if _, err := os.Stat(none); err == nil {
		t.Fatal("wrote a compose file the backup doesn't have")
	}
}

// A compose write that fails leaves the state dir as it was (#592).
func TestComposeFailsFirst(t *testing.T) {
	zipPath := zipOf(t, "cert.pem", "gateway.json", ComposeEntry)
	bad := filepath.Join(t.TempDir(), "no-such-dir", "jellyfin-compose.yml")
	old := map[string]string{"gateway.json": `{"name":"other"}`, "metadata.json": "{}"}
	for _, force := range []bool{false, true} {
		dst := filepath.Join(t.TempDir(), "state")
		if force {
			dst = writeDir(t, old)
		}
		if _, err := Restore(zipPath, dst, bad, force); err == nil {
			t.Fatalf("force=%v: no error for a missing install dir", force)
		}
		if force {
			if got := readDir(t, dst); !maps.Equal(got, old) {
				t.Fatalf("force=%v: state dir changed to %v", force, got)
			}
		} else if _, err := os.Stat(dst); err == nil {
			t.Fatal("created the state dir")
		}
	}
}

// A state write that fails removes the compose file the restore just wrote,
// so a rerun writes it again instead of keeping it as the user's (#592).
func TestStateFailsRemovesCompose(t *testing.T) {
	zipPath := zipOf(t, "cert.pem", "gateway.json", ComposeEntry)
	dst := filepath.Join(t.TempDir(), "state")
	if err := os.WriteFile(dst, nil, 0o600); err != nil { // a file where the dir should be
		t.Fatal(err)
	}
	into := filepath.Join(t.TempDir(), "jellyfin-compose.yml")
	if _, err := Restore(zipPath, dst, into, false); err == nil {
		t.Fatal("no error for a state dir that is a file")
	}
	if _, err := os.Stat(into); err == nil {
		t.Fatal("left the compose file it wrote")
	}
	// The user's own compose file stays, also when the state write fails.
	if err := os.WriteFile(into, []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Restore(zipPath, dst, into, true); err == nil {
		t.Fatal("no error for a state dir that is a file")
	}
	if b, _ := os.ReadFile(into); string(b) != "mine" {
		t.Fatalf("compose = %q, want the user's", b)
	}
}

func TestComposeTooBig(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, n := range []string{"cert.pem", "gateway.json"} {
		w, _ := zw.Create(n)
		if _, err := w.Write([]byte("x")); err != nil {
			t.Fatal(err)
		}
	}
	w, _ := zw.Create(ComposeEntry)
	if _, err := w.Write(make([]byte, maxFile+1)); err != nil {
		t.Fatal(err)
	}
	zw.Close()
	p := filepath.Join(t.TempDir(), "z.zip")
	if err := os.WriteFile(p, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	into := filepath.Join(t.TempDir(), "c.yml")
	if _, err := Restore(p, filepath.Join(t.TempDir(), "state"), into, false); err == nil {
		t.Fatal("accepted an oversized compose entry")
	}
	if _, err := os.Stat(into); err == nil {
		t.Fatal("wrote the oversized compose file")
	}
}

func TestWriteNeedsIdentity(t *testing.T) {
	if err := Write(writeDir(t, map[string]string{"allowlist.json": "[]"}), "", "", &bytes.Buffer{}); err == nil {
		t.Fatal("backed up a state dir without cert.pem/gateway.json")
	}
}

func TestFileName(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	if got := FileName(writeDir(t, state), day); got != "streamiq-gateway-Living-room-2026-11-15-000000.zip" {
		t.Fatal(got)
	}
	if got := FileName(t.TempDir(), day); got != "streamiq-gateway-2026-11-15-000000.zip" {
		t.Fatal(got)
	}
}

func TestJellyfin(t *testing.T) {
	src := writeDir(t, state)
	archive := filepath.Join(t.TempDir(), "jellyfin-backup-1.zip")
	big := bytes.Repeat([]byte("j"), maxFile+1) // over the state files' cap: never read like one
	if err := os.WriteFile(archive, big, 0o644); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := Write(src, "", archive, &buf); err != nil {
		t.Fatal(err)
	}
	zipPath := filepath.Join(t.TempDir(), "b.zip")
	if err := os.WriteFile(zipPath, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	zr, _ := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if f := zr.File[len(zr.File)-1]; f.Name != JellyfinEntry || f.Method != zip.Store {
		t.Fatalf("last entry %q method %d", f.Name, f.Method)
	}

	// gateway restore (and the installer) leave it alone.
	dst := filepath.Join(t.TempDir(), "state")
	if _, err := Restore(zipPath, dst, filepath.Join(t.TempDir(), "c.yml"), false); err != nil {
		t.Fatal(err)
	}
	want := maps.Clone(state)
	delete(want, "page-token")
	delete(want, "page-link")
	if got := readDir(t, dst); !maps.Equal(got, want) {
		t.Fatalf("state dir = %v", slices.Sorted(maps.Keys(got)))
	}

	out := filepath.Join(t.TempDir(), "jf.zip")
	creds, err := ExtractJellyfin(zipPath, out)
	if err != nil || string(creds) != state["jellyfin.json"] {
		t.Fatalf("creds %q, err %v", creds, err)
	}
	if b, _ := os.ReadFile(out); !bytes.Equal(b, big) {
		t.Fatal("archive changed on the way")
	}
	if _, err := ExtractJellyfin(zipPath, out); err == nil {
		t.Fatal("wrote over an existing file")
	}

	old := maxJellyfin
	maxJellyfin = int64(len(big)) - 1
	defer func() { maxJellyfin = old }()
	capped := filepath.Join(t.TempDir(), "jf.zip")
	if _, err := ExtractJellyfin(zipPath, capped); err == nil {
		t.Fatal("accepted an archive over the cap")
	}
	if _, err := os.Stat(capped); err == nil {
		t.Fatal("left the oversized archive behind")
	}
}

func TestNoJellyfin(t *testing.T) {
	if _, err := ExtractJellyfin(backupFile(t, writeDir(t, state)), filepath.Join(t.TempDir(), "x")); !errors.Is(err, ErrNoJellyfin) {
		t.Fatalf("err %v", err)
	}
}

// zipFiles returns the entries of a zip holding names (each "x").
func zipFiles(t *testing.T, names ...string) []*zip.File {
	t.Helper()
	zr, err := zip.OpenReader(zipOf(t, names...))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { zr.Close() })
	return zr.File
}

func TestCheckEntries(t *testing.T) {
	if err := checkEntries("z", zipFiles(t, "cert.pem", "gateway.json", "allowlist.json", ComposeEntry, JellyfinEntry)); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"../evil", "sub/x", `sub\x`, "C:x", "dir/", "..", "."} {
		if err := checkEntries("z", zipFiles(t, "cert.pem", "gateway.json", bad)); err == nil {
			t.Errorf("%q: accepted", bad)
		}
	}
	if err := checkEntries("z", zipFiles(t, "cert.pem")); err == nil || !strings.Contains(err.Error(), "no gateway.json") {
		t.Errorf("err = %v, want no gateway.json", err)
	}
}

func TestCheckJSON(t *testing.T) {
	if err := checkJSON("gateway.json", []byte(`{"gatewayId":`)); err == nil {
		t.Error("accepted cut-short JSON")
	}
	if err := checkJSON("gateway.json", []byte(`{}`)); err != nil {
		t.Error(err)
	}
	if err := checkJSON("cert.pem", []byte(`{`)); err != nil {
		t.Errorf("checked a non-JSON file: %v", err)
	}
}

func TestCheckNoIdentity(t *testing.T) {
	if err := checkNoIdentity(filepath.Join(t.TempDir(), "missing")); err != nil {
		t.Fatal(err)
	}
	if err := checkNoIdentity(writeDir(t, map[string]string{"allowlist.json": "[]"})); err != nil {
		t.Fatal(err)
	}
	err := checkNoIdentity(writeDir(t, map[string]string{"cert.pem": "C"}))
	if err == nil || !strings.Contains(err.Error(), "cert.pem") || strings.Contains(err.Error(), "gateway.json") {
		t.Fatalf("err = %v, want one naming only cert.pem", err)
	}
}

func TestReadEntriesCap(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for n, size := range map[string]int{"ok": maxFile, "big": maxFile + 1, JellyfinEntry: maxFile + 1} {
		w, _ := zw.Create(n)
		if _, err := w.Write(make([]byte, size)); err != nil {
			t.Fatal(err)
		}
	}
	zw.Close()
	zr, _ := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	var big, rest []*zip.File
	for _, f := range zr.File {
		if f.Name == "big" {
			big = append(big, f)
		} else {
			rest = append(rest, f)
		}
	}
	files, err := readEntries("z", rest)
	if err != nil || len(files) != 1 || len(files["ok"]) != maxFile {
		t.Fatalf("read %d files, err %v: want only ok at the cap (Jellyfin skipped)", len(files), err)
	}
	if _, err := readEntries("z", big); err == nil || !strings.Contains(err.Error(), "too big") {
		t.Fatalf("err = %v, want too big", err)
	}
}

func TestStale(t *testing.T) {
	dir := writeDir(t, map[string]string{"gateway.json": "{}", "allowlist.json": "[]", "page-token": "t", "page-link": "l"})
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	got, err := stale(dir, map[string][]byte{"gateway.json": nil, ComposeEntry: nil})
	if err != nil || !slices.Equal(got, []string{"allowlist.json"}) {
		t.Fatalf("stale = %v, err %v; want [allowlist.json]", got, err)
	}
}

func TestWriteCompose(t *testing.T) {
	into := filepath.Join(t.TempDir(), "c.yml")
	if did, err := writeCompose(into, strings.NewReader("new")); err != nil || did != ComposeWritten {
		t.Fatalf("did %q, err %v", did, err)
	}
	if did, err := writeCompose(into, strings.NewReader("other")); err != nil || did != ComposeKept {
		t.Fatalf("did %q, err %v", did, err)
	}
	if b, _ := os.ReadFile(into); string(b) != "new" {
		t.Fatalf("compose = %q", b)
	}
	failed := filepath.Join(t.TempDir(), "c.yml")
	if _, err := writeCompose(failed, io.MultiReader(strings.NewReader("part"), iotest.ErrReader(errors.New("boom")))); err == nil {
		t.Fatal("no error from a failed write")
	}
	if _, err := os.Stat(failed); err == nil {
		t.Fatal("left a partial compose file")
	}
}

func TestReadEntriesTotalCap(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, n := range []string{"a", "b", "c"} { // each at maxFile, together over maxTotal
		w, err := zw.Create(n)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(make([]byte, maxFile)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := readEntries("z", zr.File[:2]); err != nil {
		t.Fatalf("two at the cap: %v", err)
	}
	if _, err := readEntries("z", zr.File); err == nil || !strings.Contains(err.Error(), "MiB unpacked") {
		t.Fatalf("err = %v, want the total cap", err)
	}
}
