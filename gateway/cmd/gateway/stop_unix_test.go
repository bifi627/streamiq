//go:build !windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// TestHelperSleep is the stand-in process startAs runs, not a test.
func TestHelperSleep(*testing.T) {
	if os.Getenv("STREAMIQ_TEST_SLEEP") == "1" {
		time.Sleep(time.Minute) //nolint:forbidigo // a process for the test to kill, not a wait
	}
}

// startAs runs this test binary copied to dir/name, sleeping in TestHelperSleep
// (not a copied sleep: a multicall coreutils exits under another name), with
// arguments so install.sh's pkill pattern (full path, no arguments) can't match it.
func startAs(t *testing.T, dir, name string) (*exec.Cmd, <-chan struct{}) {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), b, 0o700); err != nil {
		t.Fatal(err)
	}
	c := exec.Command("./"+name, "-test.run=^TestHelperSleep$")
	c.Dir, c.Env = dir, append(os.Environ(), "STREAMIQ_TEST_SLEEP=1")
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{}) // closed when it exits: Wait only here (it isn't safe twice at once)
	go func() { _ = c.Wait(); close(done) }()
	t.Cleanup(func() { _ = c.Process.Kill(); <-done })
	if exited(done, 200*time.Millisecond) {
		t.Fatal("the stand-in exited on its own")
	}
	return c, done
}

func exited(done <-chan struct{}, within time.Duration) bool {
	select {
	case <-done:
		return true
	case <-time.After(within):
		return false
	}
}

func TestStopGatewayByPidFile(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "gateway")
	c, done := startAs(t, dir, "gateway")
	if err := os.WriteFile(exe+".pid", []byte(strconv.Itoa(c.Process.Pid)), 0o600); err != nil {
		t.Fatal(err)
	}
	stopGateway(exe)
	if !exited(done, 5*time.Second) {
		t.Fatal("a gateway started as ./gateway with arguments still runs")
	}
}

func TestStopGatewayStalePidFile(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "gateway")
	c, done := startAs(t, dir, "other") // the pid now belongs to another program
	if err := os.WriteFile(exe+".pid", []byte(strconv.Itoa(c.Process.Pid)), 0o600); err != nil {
		t.Fatal(err)
	}
	stopGateway(exe)
	if exited(done, time.Second) {
		t.Fatal("killed a process that isn't a gateway")
	}
	if _, ok := gatewayPid(exe); ok {
		t.Fatal("gatewayPid names a process that isn't a gateway")
	}
}
