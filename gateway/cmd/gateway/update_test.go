package main

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckUpdate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"tag_name":"gateway-v1.2.0"}`)
	}))
	defer srv.Close()
	if _, _, err := checkUpdate(
		t.Context(),
		"dev",
		srv.URL,
	); err == nil ||
		!strings.Contains(err.Error(), "dev build") {
		t.Errorf("dev build: err = %v, want it refused", err)
	}
	for cur, want := range map[string]bool{"1.2.0": false, "1.3.0": false, "1.1.9": true} {
		latest, ok, err := checkUpdate(t.Context(), cur, srv.URL)
		if err != nil || latest != "1.2.0" || ok != want {
			t.Errorf("v%s: (%q, %v, %v), want (1.2.0, %v, nil)", cur, latest, ok, err, want)
		}
	}
}

func TestBackupFailedCleansUp(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "gateway")
	keep, older := filepath.Join(dir, "backups", "b"), filepath.Join(dir, "backups", "older")
	for _, d := range []string{keep, older} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{exe, exe + ".new", filepath.Join(keep, "state.zip")} {
		if err := os.WriteFile(f, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	err := backupFailed(exe, keep, errors.New("disk full"))
	if err == nil || err.Error() != "backup before the update failed, nothing changed: disk full" {
		t.Errorf("err = %v", err)
	}
	for _, gone := range []string{exe + ".new", keep} {
		if _, err := os.Stat(gone); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s still there", gone)
		}
	}
	for _, kept := range []string{exe, older} {
		if _, err := os.Stat(kept); err != nil {
			t.Errorf("%s: %v, want it untouched", kept, err)
		}
	}
	// BackupDir itself failed: no backup dir to remove yet.
	if err := backupFailed(exe, "", errors.New("no dir")); err == nil {
		t.Error("want an error")
	}
}

func TestSwapErrorPrecedence(t *testing.T) {
	errStart := errors.New("start failed")
	for _, tc := range []struct {
		name      string
		swapFails bool
		start     error
	}{
		{"neither", false, nil},
		{"start only", false, errStart},
		{"swap only", true, nil},
		{"both: swap wins", true, errStart},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			exe, keep := filepath.Join(dir, "gateway"), filepath.Join(dir, "keep")
			if err := os.Mkdir(keep, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(exe, []byte("old"), 0o600); err != nil {
				t.Fatal(err)
			}
			if !tc.swapFails { // no exe.new: the swap fails and puts exe back
				if err := os.WriteFile(exe+".new", []byte("new"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			var calls []string
			err := swap(exe, keep, true,
				func(string) { calls = append(calls, "stop") },
				func() error { calls = append(calls, "start"); return tc.start })
			if got := strings.Join(calls, ","); got != "stop,start" {
				t.Errorf("calls = %s, want stop,start", got)
			}
			switch {
			case tc.swapFails && (err == nil || errors.Is(err, errStart)):
				t.Errorf("err = %v, want the swap's error", err)
			case !tc.swapFails && err != tc.start:
				t.Errorf("err = %v, want %v", err, tc.start)
			}
			want := "new"
			if tc.swapFails {
				want = "old"
			}
			if b, _ := os.ReadFile(exe); string(b) != want {
				t.Errorf("exe holds %q, want %q", b, want)
			}
		})
	}
}

func TestSwapWithoutTask(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "gateway")
	for _, f := range []string{exe, exe + ".new"} {
		if err := os.WriteFile(f, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	stop := func(string) { t.Error("stop called without a task") }
	start := func() error { t.Error("start called without a task"); return nil }
	keep := filepath.Join(dir, "keep")
	if err := os.Mkdir(keep, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := swap(exe, keep, false, stop, start); err != nil {
		t.Error(err)
	}
}

func TestUpdatedMessage(t *testing.T) {
	keep := filepath.Join("backups", "b")
	kept := "v1.1.0 and its state are kept in " + keep + ": gateway rollback goes back to it.\n"
	if got, want := updated(
		"1.1.0",
		"1.2.0",
		keep,
		true,
	), "Updated v1.1.0 → v1.2.0 and restarted.\n"+kept; got != want {
		t.Errorf("with the task:\n%q\nwant\n%q", got, want)
	}
	want := "Updated v1.1.0 → v1.2.0. Restart the gateway to run it (or: gateway service install).\n" + kept
	if got := updated("1.1.0", "1.2.0", keep, false); got != want {
		t.Errorf("without the task:\n%q\nwant\n%q", got, want)
	}
}
