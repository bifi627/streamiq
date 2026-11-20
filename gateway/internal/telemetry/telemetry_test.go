package telemetry

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"streamiq/gateway/internal/tunnel"
)

// Missing, unreadable or unknown = off (opt-in); Write stores a valid level only.
func TestLevel(t *testing.T) {
	dir := t.TempDir()
	if l := Read(dir); l != Off {
		t.Fatalf("missing file: %q, want off", l)
	}
	for _, garbage := range []string{"", "FULL", "on", "full please"} {
		_ = os.WriteFile(filepath.Join(dir, "telemetry"), []byte(garbage), 0o600)
		if l := Read(dir); l != Off {
			t.Fatalf("%q: %q, want off", garbage, l)
		}
	}
	if err := Write(dir, "on"); err != ErrBadLevel {
		t.Fatalf("Write(on) = %v", err)
	}
	for _, l := range Levels {
		if err := Write(dir, l); err != nil || Read(dir) != l {
			t.Fatalf("Write(%s): %v, read %q", l, err, Read(dir))
		}
	}
	os.Remove(filepath.Join(dir, "telemetry"))
	_ = os.Mkdir(filepath.Join(dir, "telemetry"), 0o700) // unreadable as a file
	if l := Read(dir); l != Off {
		t.Fatalf("unreadable: %q, want off", l)
	}
}

// POST /streamiq/telemetry: admin-only, writes the file and asks for an early
// heartbeat; a bad level or body is 400 and changes nothing.
func TestSwitch(t *testing.T) {
	dir := t.TempDir()
	beats := 0
	rt := tunnel.NewRouter()
	rt.Handle("POST "+Path, &Switch{Dir: dir, Changed: func() { beats++ }}, tunnel.AdminOnly)
	for _, c := range []struct {
		role, body string
		want       int
	}{
		{tunnel.Member, `{"level":"full"}`, http.StatusForbidden},
		{tunnel.Admin, `{"level":"on"}`, http.StatusBadRequest},
		{tunnel.Admin, `{}`, http.StatusBadRequest},
		{tunnel.Admin, `nope`, http.StatusBadRequest},
	} {
		if s, _, _, _ := tunnel.Do(rt, tunnel.Session{Role: c.role}, "POST", Path, c.body); s != c.want {
			t.Errorf("%s %s: %d, want %d", c.role, c.body, s, c.want)
		}
	}
	if Read(dir) != Off || beats != 0 {
		t.Fatalf("a refused call changed the level (%s) or beat (%d)", Read(dir), beats)
	}
	if s, _, _, _ := tunnel.Do(
		rt,
		tunnel.Session{Role: tunnel.Admin},
		"POST",
		Path,
		`{"level":"full"}`,
	); s != http.StatusOK ||
		Read(dir) != Full ||
		beats != 1 {
		t.Fatalf("admin full: %d, level %s, %d beats", s, Read(dir), beats)
	}
}
