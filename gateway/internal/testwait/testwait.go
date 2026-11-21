// Package testwait is for tests that wait on state another goroutine changes over a
// real socket or WebRTC connection, which testing/synctest can't fake. A test that
// waits only on timers and channels uses synctest instead.
package testwait

import (
	"testing"
	"time"
)

// Until polls cond until it holds, and fails the test with msg once timeout passes.
func Until(t testing.TB, timeout time.Duration, cond func() bool, msg string, args ...any) {
	t.Helper()
	for deadline := time.Now().Add(timeout); !cond(); {
		if time.Now().After(deadline) {
			t.Fatalf(msg, args...)
		}
		time.Sleep(10 * time.Millisecond) //nolint:forbidigo // real I/O: synctest can't fake it
	}
}
