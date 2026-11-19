package jellyfin

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// managed is a Setup on a Jellyfin it set up, with an install dir holding the
// compose file and jellyfin-config.
func managed(t *testing.T) (*fake, *Setup, string) {
	f, srv := newFake(t, false)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	s.poll(context.Background())
	dir := t.TempDir()
	compose := filepath.Join(dir, ComposeFile)
	if err := os.WriteFile(compose, []byte("services: {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "jellyfin-config", "data", "backups"), 0o755); err != nil {
		t.Fatal(err)
	}
	return f, s, compose
}

func TestCreateBackup(t *testing.T) {
	f, s, compose := managed(t)
	ctx := context.Background()

	// The archive Jellyfin reports isn't in this install dir: another Jellyfin.
	if _, _, err := s.CreateBackup(ctx, compose); err == nil || !strings.Contains(err.Error(), "is not in") {
		t.Fatalf("err %v", err)
	}
	want := filepath.Join(filepath.Dir(compose), "jellyfin-config", "data", "backups", "jellyfin-backup-1.zip")
	if err := os.WriteFile(want, []byte("zip"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, remove, err := s.CreateBackup(ctx, compose)
	if err != nil || got != want || remove == nil {
		t.Fatalf("archive %q, err %v", got, err)
	}
	if f.backups != 2 {
		t.Fatalf("%d backups", f.backups)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, u := range f.tokens {
		if u == adminName {
			t.Fatal("admin session not logged out")
		}
	}
}

func TestCreateBackupSkips(t *testing.T) {
	ctx := context.Background()
	for name, tc := range map[string]func(*fake, *Setup, string) string{
		"no compose file": func(f *fake, s *Setup, compose string) string {
			os.Remove(compose)
			return compose
		},
		"no jellyfin-config": func(f *fake, s *Setup, compose string) string {
			os.RemoveAll(filepath.Join(filepath.Dir(compose), "jellyfin-config"))
			return compose
		},
		"password refused": func(f *fake, s *Setup, compose string) string {
			f.users[adminName].pw = "changed by a human"
			return compose
		},
		"unreachable": func(f *fake, s *Setup, compose string) string {
			s.URL = "http://127.0.0.1:1"
			return compose
		},
		"not set up by the gateway": func(f *fake, s *Setup, compose string) string {
			c := s.creds
			c.BYO = true
			if err := s.save(c); err != nil {
				t.Error(err) // the subtest's goroutine: no t.Fatal on the parent
			}
			return compose
		},
	} {
		t.Run(name, func(t *testing.T) {
			f, s, compose := managed(t)
			compose = tc(f, s, compose)
			before := f.signIns
			if _, _, err := s.CreateBackup(ctx, compose); err == nil {
				t.Fatal("not skipped")
			}
			if f.backups != 0 {
				t.Fatal("Jellyfin made a backup")
			}
			if f.signIns-before > 1 {
				t.Fatalf("%d sign-ins: a refused password is never retried", f.signIns-before)
			}
		})
	}
}

func TestAwaitRestored(t *testing.T) {
	ctx := context.Background()
	f, s, _ := managed(t)
	bc := s.creds

	// Still up before the restart: no sign-in until it went down and came back.
	f.info = []int{200, 503, 503}
	before := f.signIns
	if err := s.awaitRestored(ctx, bc, 10*time.Second); err != nil {
		t.Fatal(err)
	}
	if f.signIns-before != 1 || len(f.info) != 0 {
		t.Fatalf("%d sign-ins, %v left", f.signIns-before, f.info)
	}

	// Back, but the backup's password is refused: one try, then the error.
	f.info = []int{503}
	bc.Password = "not the restored one"
	before = f.signIns
	if err := s.awaitRestored(ctx, bc, 10*time.Second); err == nil || f.signIns-before != 1 {
		t.Fatalf("err %v, %d sign-ins", err, f.signIns-before)
	}

	// Never went down: the restore didn't run.
	before = f.signIns
	if err := s.awaitRestored(ctx, s.creds, time.Second); err == nil || f.signIns != before {
		t.Fatalf("err %v, %d sign-ins", err, f.signIns-before)
	}
}

func TestRestoreRefusals(t *testing.T) {
	_, s, compose := managed(t)
	ctx := context.Background()
	if err := RestoreCLI(ctx, s, compose, "x.zip", []byte(`{"user":"me","password":"pw","byo":true}`), &strings.Builder{}); err == nil {
		t.Fatal("restored with the login of a Jellyfin the gateway didn't set up")
	}
	if err := RestoreCLI(ctx, s, filepath.Join(t.TempDir(), ComposeFile), "x.zip", []byte(`{"user":"streamiq","password":"pw"}`), &strings.Builder{}); err == nil {
		t.Fatal("restored without a compose file")
	}
}

func TestVersion3(t *testing.T) {
	if version3("12.4.0.0") != version3("12.4.0") || version3("12.4.1") == version3("12.4.0") {
		t.Fatal(version3("12.4.0.0"))
	}
}
