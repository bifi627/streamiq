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

// startAs runs sleep copied to dir/name, with an argument so install.sh's pkill
// pattern (full path, no arguments) can't match it.
func startAs(t *testing.T, dir, name string) (*exec.Cmd, <-chan struct{}) {
	t.Helper()
	sleep, err := exec.LookPath("sleep")
	if err != nil {
		t.Skip("no sleep")
	}
	b, err := os.ReadFile(sleep)
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, name)
	if err := os.WriteFile(bin, b, 0o700); err != nil {
		t.Fatal(err)
	}
	c := exec.Command("./"+name, "60")
	c.Dir = dir
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{}) // closed when it exits: Wait only here (it isn't safe twice at once)
	go func() { _ = c.Wait(); close(done) }()
	t.Cleanup(func() { _ = c.Process.Kill(); <-done })
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
