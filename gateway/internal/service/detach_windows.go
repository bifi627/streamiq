package service

import (
	"os/exec"
	"syscall"
)

// Detach makes c (the updater a remote update starts, #312) outlive the
// logon task it runs from: `schtasks /End` ends the task's console and the
// gateway in it, not a process without a console. The task's job refuses
// CREATE_BREAKAWAY_FROM_JOB, so it stays in the job; /End doesn't end the job
// itself (both tried in the #312 spike).
func Detach(c *exec.Cmd) {
	const detachedProcess = 0x00000008 // DETACHED_PROCESS: no console
	c.SysProcAttr = &syscall.SysProcAttr{CreationFlags: detachedProcess | syscall.CREATE_NEW_PROCESS_GROUP}
}
