package update

import (
	"errors"
	"net/http"
	"testing"
	"testing/synctest"

	"streamiq/gateway/internal/tunnel"
)

// Each refusal reason, then one start; a second Run while the updater runs is
// refused and starts nothing, and it is possible again once the updater exits.
func TestRemote(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		newer, task, starts := "1.5.0", true, 0
		exited := make(chan struct{})
		r := &Remote{Version: "1.4.0", Supported: true,
			Newer: func() string { return newer }, Task: func() bool { return task },
			Start: func() (func(), error) { starts++; return func() { <-exited }, nil }}
		for _, c := range []struct {
			set  func()
			want string
		}{
			{func() { r.Supported = false }, "remote update works on Windows only so far"},
			{func() { r.Supported, r.Version = true, "dev" }, "dev build"},
			{func() { r.Version, newer = "1.4.0", "" }, "already up to date"},
			{func() { newer = "1.4.0" }, "already up to date"},
			{func() { newer, task = "1.5.0", false }, "no logon task, so nothing would start the gateway again after the update"},
		} {
			c.set()
			if v, why, err := r.Run(); why != c.want || v != "" || err != nil || r.Reason() != c.want {
				t.Fatalf("Run = %q %q %v, want refused %q", v, why, err, c.want)
			}
		}
		task = true
		if r.Reason() != "" {
			t.Fatalf("Reason = %q, want possible", r.Reason())
		}
		if v, why, err := r.Run(); v != "1.5.0" || why != "" || err != nil || starts != 1 {
			t.Fatalf("Run = %q %q %v starts=%d", v, why, err, starts)
		}
		if _, why, _ := r.Run(); why != "an update is already running" || starts != 1 {
			t.Fatalf("second Run: %q starts=%d", why, starts)
		}
		close(exited)   // the updater failed: the gateway still runs, it may try again
		synctest.Wait() // the updater exited
		if why := r.Reason(); why != "" {
			t.Fatalf("still %q after the updater exited", why)
		}
		if _, why, _ := r.Run(); why != "" || starts != 2 {
			t.Fatalf("after exit: %q starts=%d", why, starts)
		}
	})
}

// POST /streamiq/update (#312): admin-only, 202 with the target version, a
// refusal is 409 with its reason, a failed start 500.
func TestRemoteAPI(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		started, fail := 0, error(nil)
		r := &Remote{
			Version:   "1.4.0",
			Supported: true,
			Newer:     func() string { return "1.5.0" },
			Task:      func() bool { return true },
			Start:     func() (func(), error) { started++; return func() {}, fail },
		}
		api := tunnel.NewRouter()
		api.Handle("POST "+Path, r, tunnel.AdminOnly)
		call := func(role string) (int, string) {
			s, _, body, _ := tunnel.Do(api, tunnel.Session{Role: role}, "POST", Path, "")
			return s, body
		}
		for _, role := range []string{tunnel.Member, ""} {
			if st, _ := call(role); st != http.StatusForbidden || started != 0 {
				t.Fatalf("%q: %d started=%d, want 403 and nothing started", role, st, started)
			}
		}
		if st, body := call(tunnel.Admin); st != http.StatusAccepted || body != `{"version":"1.5.0"}` || started != 1 {
			t.Fatalf("admin: %d %s started=%d", st, body, started)
		}
		synctest.Wait() // the fake updater exits at once
		r.Version = "1.5.0"
		if st, body := call(tunnel.Admin); st != http.StatusConflict || body != `{"reason":"already up to date"}` {
			t.Fatalf("refused: %d %s", st, body)
		}
		r.Version, fail = "1.4.0", errors.New("exec: access denied")
		if st, _ := call(tunnel.Admin); st != http.StatusInternalServerError {
			t.Fatalf("failing start: %d, want 500", st)
		}
	})
}
