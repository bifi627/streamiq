//go:build !windows

package service

import "os/exec"

// Detach is a no-op off Windows: there is no remote update there yet.
func Detach(*exec.Cmd) {}
