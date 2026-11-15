package backup

import (
	"archive/zip"
	"bytes"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	if err := Write(dir, &buf); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "b.zip")
	os.WriteFile(p, buf.Bytes(), 0o600)
	return p
}

func zipOf(t *testing.T, names ...string) string {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, n := range names {
		w, _ := zw.Create(n)
		w.Write([]byte("x"))
	}
	zw.Close()
	p := filepath.Join(t.TempDir(), "z.zip")
	os.WriteFile(p, buf.Bytes(), 0o600)
	return p
}

func TestRoundTrip(t *testing.T) {
	src := writeDir(t, state)
	os.Mkdir(filepath.Join(src, "sub"), 0o700) // only regular files go in
	dst := filepath.Join(t.TempDir(), "state")
	if err := Restore(backupFile(t, src), dst, false); err != nil {
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
	err := Restore(zipPath, dst, false)
	if err == nil || !strings.Contains(err.Error(), "gateway.json") || !strings.Contains(err.Error(), "--force") {
		t.Fatalf("err = %v, want a refusal naming gateway.json and --force", err)
	}
	if readDir(t, dst)["gateway.json"] != `{"name":"other"}` {
		t.Fatal("refused restore changed the state dir")
	}
	if err := Restore(zipPath, dst, true); err != nil {
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
	for _, bad := range []string{"../evil", "sub/x", `sub\x`, "/abs", "C:x", "dir/", ".."} {
		dst := filepath.Join(t.TempDir(), "state")
		if err := Restore(zipOf(t, "cert.pem", "gateway.json", bad), dst, false); err == nil {
			t.Errorf("%q: accepted", bad)
		}
		if _, err := os.Stat(dst); err == nil {
			t.Errorf("%q: wrote the state dir before rejecting", bad)
		}
	}
	if err := Restore(zipOf(t, "cert.pem"), t.TempDir(), false); err == nil {
		t.Error("zip without gateway.json accepted")
	}
}

func TestWriteNeedsIdentity(t *testing.T) {
	if err := Write(writeDir(t, map[string]string{"allowlist.json": "[]"}), &bytes.Buffer{}); err == nil {
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
