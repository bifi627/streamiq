//go:build docker

package jellyfin

import (
	"bytes"
	"context"
	"crypto/rand"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
)

// The real pinned Jellyfin, not the fake (#453): CreateBackup → RestoreCLI
// against the shipped install/jellyfin-compose.yml, and a backup made by the
// last release's pin restored into the current one. Needs Docker; opt-in:
//
//	go test -tags docker -run TestRealJellyfin ./internal/jellyfin/
//
// STREAMIQ_TEST_OLD_JELLYFIN_COMPOSE is the last release's jellyfin-compose.yml
// (gh release download --pattern jellyfin-compose.yml); unset, or the same pin
// as now, skips the pin bump. CI: job gateway-jellyfin.
func TestRealJellyfin(t *testing.T) {
	cur, err := os.ReadFile(filepath.Join("..", "..", "install", ComposeFile))
	if err != nil {
		t.Fatal(err)
	}
	t.Run("round trip", func(t *testing.T) {
		t.Parallel()
		roundTrip(t, cur)
	})
	t.Run("from the last release's pin", func(t *testing.T) {
		t.Parallel()
		p := os.Getenv("STREAMIQ_TEST_OLD_JELLYFIN_COMPOSE")
		if p == "" {
			t.Skip("STREAMIQ_TEST_OLD_JELLYFIN_COMPOSE not set (the last release's jellyfin-compose.yml)")
		}
		old, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		if _, bump, err := Pin(old); err != nil {
			t.Fatal(err)
		} else if !bump {
			t.Skipf("the last release pins %s too: the round trip covers it", Image)
		}
		roundTrip(t, old)
	})
}

var projectLine = regexp.MustCompile(`(?m)^name: .*$`)

// roundTrip: jellyfin up with compose, the gateway completes the wizard, a
// backup, a change, `gateway jellyfin upgrade` to Image (a no-op on the
// current file), the restore. The change must be gone and the restored
// jellyfin.json's admin must sign in.
func roundTrip(t *testing.T, compose []byte) {
	ctx := t.Context()
	if d, ok := t.Deadline(); ok { // fail before go test's timeout panic, which skips the cleanup
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, d.Add(-4*time.Minute))
		defer cancel()
	}
	dir := t.TempDir()
	for _, d := range []string{"jellyfin-config", "media"} { // ours, not created by Docker as root
		if err := os.Mkdir(filepath.Join(dir, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// Its own project and a free port: tests and a real install side by side.
	if !projectLine.Match(compose) {
		t.Fatal("no top-level name: in the compose file: update this test")
	}
	b := projectLine.ReplaceAll(compose, []byte("name: streamiq-jellyfin-test-"+strings.ToLower(rand.Text()[:10])))
	if !bytes.Contains(b, []byte(`"8096:8096"`)) {
		t.Fatal(`no "8096:8096" port in the compose file: update this test`)
	}
	b = bytes.ReplaceAll(b, []byte(`"8096:8096"`), []byte(`"127.0.0.1::8096"`)) // also the commented "online" one
	file := filepath.Join(dir, ComposeFile)
	if err := os.WriteFile(file, b, 0o644); err != nil {
		t.Fatal(err)
	}
	docker := func(ctx context.Context, args ...string) (string, error) {
		out, err := exec.CommandContext(ctx, "docker", append([]string{"compose", "-f", file}, args...)...).
			CombinedOutput()
		return string(out), err
	}
	t.Cleanup(func() { // also on failure; before t.TempDir's removal (LIFO)
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		if t.Failed() {
			out, _ := docker(cleanupCtx, "logs", "--no-color", "--tail", "100", service)
			t.Log("Jellyfin's log:\n" + out)
		}
		// nothing writes while it's emptied; t.Error: the cleanup below still runs
		if _, err := docker(cleanupCtx, "stop", service); err != nil {
			t.Error(err)
		}
		// Jellyfin writes jellyfin-config as root (Linux): emptied from inside, or the temp dir stays
		if out, err := docker(
			cleanupCtx,
			"run",
			"--rm",
			"--no-deps",
			"-T",
			"--entrypoint",
			"find",
			service,
			"/config",
			"-mindepth",
			"1",
			"-delete",
		); err != nil {
			t.Logf("emptying jellyfin-config: %v: %s", err, out)
		}
		if out, err := docker(cleanupCtx, "down", "-v", "--remove-orphans"); err != nil {
			t.Errorf("compose down: %v: %s", err, out)
		}
	})

	if err := Compose(ctx, file, "up", "-d"); err != nil { // what `gateway jellyfin up` runs
		t.Fatal(err)
	}
	port, err := exec.CommandContext(ctx, "docker", "compose", "-f", file, "port", "forwarder", "8096").
		Output()
		// stdout only: it's parsed
	if err != nil {
		t.Fatalf("compose port: %v", err)
	}
	s := &Setup{
		Client:   http.DefaultClient,
		URL:      "http://" + strings.TrimSpace(string(port)),
		StateDir: t.TempDir(),
		OnKey:    func(string, string) {},
	}

	// 1. The gateway completes the setup wizard.
	for deadline := time.Now().Add(3 * time.Minute); !s.View().HasKey; {
		if time.Now().After(deadline) || ctx.Err() != nil {
			t.Fatalf("the gateway did not set Jellyfin up: %+v", s.View())
		}
		s.poll(ctx)
		time.Sleep(2 * time.Second) //nolint:forbidigo // a real Jellyfin container, polled every 2 s
	}
	if !s.View().Managed {
		t.Fatalf("not managed: %+v", s.View())
	}
	creds, err := os.ReadFile(s.path())
	if err != nil {
		t.Fatal(err)
	}

	// 2. The backup, and its version.
	archive, _, err := s.CreateBackup(ctx, file)
	if err != nil {
		t.Fatal(err)
	}
	if v, want := backupVersion(archive), s.View().Version; v == "" || version3(v) != version3(want) {
		t.Fatalf("backupVersion %q, Jellyfin runs %q", v, want)
	}

	// 3. A change: a user the backup doesn't have.
	const added = "streamiq-test-added"
	admin := signIn(t, s)
	if err := s.call(ctx, "POST", "/Users/New", admin, `{"Name":"`+added+`","Password":"x"}`, nil); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(users(t, s, admin), added) {
		t.Fatal("the added user isn't there")
	}
	s.logout(ctx, admin)

	// Telemetry's transcode count: real /Sessions, and its kept token outlives
	// the gateway's other admin sign-in and sign-out above.
	if n, err := s.Transcodes(ctx); err != nil || n != 0 {
		t.Fatalf("Transcodes = %d, %v", n, err)
	}
	tele := s.tele
	admin = signIn(t, s)
	s.logout(ctx, admin)
	if n, err := s.Transcodes(ctx); err != nil || n != 0 || s.tele != tele {
		t.Fatalf("Transcodes after another admin sign-in = %d, %v (token kept: %v)", n, err, s.tele == tele)
	}

	// The pin bump: `gateway jellyfin upgrade` (prints "Already on" on the current file).
	var out bytes.Buffer
	if err := Upgrade(ctx, file, &out); err != nil {
		t.Fatalf("upgrade: %v\n%s", err, &out)
	}
	t.Log(strings.TrimSpace(out.String()))
	// Up again: a sign-in, not /System/Info/Public, which a starting Jellyfin answers before it restarts its listener.
	for deadline := time.Now().Add(3 * time.Minute); ; {
		s.mu.Lock()
		pw := s.creds.Password
		s.mu.Unlock()
		token, err := s.signIn(ctx, adminName, pw)
		if err == nil {
			s.logout(ctx, token)
			break
		}
		if unauthorized(err) || time.Now().After(deadline) || ctx.Err() != nil {
			t.Fatalf("Jellyfin after the upgrade: %v", err)
		}
		time.Sleep(2 * time.Second) //nolint:forbidigo // a real Jellyfin container, polled every 2 s
	}

	// 4. The restore.
	out.Reset()
	if err := RestoreCLI(ctx, s, file, archive, creds, &out); err != nil {
		t.Fatalf("restore: %v\n%s", err, &out)
	}
	t.Log(strings.TrimSpace(out.String()))

	// 5. The change is gone, and the restored jellyfin.json's admin signs in.
	r := &Setup{Client: http.DefaultClient, URL: s.URL, StateDir: s.StateDir, OnKey: func(string, string) {}}
	if err := r.Load(); err != nil {
		t.Fatal(err)
	}
	admin = signIn(t, r)
	defer r.logout(ctx, admin)
	if u := users(t, r, admin); slices.Contains(u, added) || !slices.Contains(u, adminName) {
		t.Fatalf("users after the restore: %v", u)
	}
}

func signIn(t *testing.T, s *Setup) string {
	t.Helper()
	s.mu.Lock()
	user, pw := s.creds.User, s.creds.Password
	s.mu.Unlock()
	tok, err := s.signIn(t.Context(), user, pw)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func users(t *testing.T, s *Setup, admin string) []string {
	t.Helper()
	var us []struct{ Name string }
	if err := s.call(t.Context(), "GET", "/Users", admin, "", &us); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, u := range us {
		names = append(names, u.Name)
	}
	return names
}
