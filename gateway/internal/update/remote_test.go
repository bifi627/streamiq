package update

import (
	"testing"
	"time"
)

// Each refusal reason, then one start; a second Run while the updater runs is
// refused and starts nothing, and it is possible again once the updater exits.
func TestRemote(t *testing.T) {
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
	close(exited) // the updater failed: the gateway still runs, it may try again
	for end := time.Now().Add(5 * time.Second); r.Reason() != ""; time.Sleep(time.Millisecond) {
		if time.Now().After(end) {
			t.Fatalf("still %q after the updater exited", r.Reason())
		}
	}
	if _, why, _ := r.Run(); why != "" || starts != 2 {
		t.Fatalf("after exit: %q starts=%d", why, starts)
	}
}
