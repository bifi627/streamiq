// Package service runs the gateway at logon on Windows: a scheduled task that
// starts it in a visible console window (cmd /k keeps the window open after a
// fatal error so it stays readable; no hidden start, #88/#69). Linux/macOS: #119.
package service

import (
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"unicode/utf16"
)

// Task is the scheduled task's name.
const Task = "streamiq-gateway"

// ErrUnsupported is what `service` and `update` say outside Windows.
var ErrUnsupported = fmt.Errorf("not supported yet on %s, use install.sh", runtime.GOOS)

// Supported reports whether this OS has a service implementation.
func Supported() bool { return runtime.GOOS == "windows" }

// Install creates (or replaces) the logon task for exe, then (re)starts it now.
func Install(exe string) error {
	if !Supported() {
		return ErrUnsupported
	}
	u, err := user.Current()
	if err != nil {
		return err
	}
	// Written next to the exe, not %TEMP% (AV heuristics, #69); removed right after.
	path := filepath.Join(filepath.Dir(exe), "task.xml")
	if err := os.WriteFile(path, TaskXML(u.Username, exe, filepath.Dir(exe)), 0o600); err != nil {
		return err
	}
	defer os.Remove(path)
	if err := schtasks("/Create", "/F", "/TN", Task, "/XML", path); err != nil {
		return err
	}
	Stop(exe)
	return Start()
}

// Uninstall stops the gateway and removes the task. state/ and gateway.env stay.
func Uninstall(exe string) error {
	if !Supported() {
		return ErrUnsupported
	}
	if !Installed() {
		return fmt.Errorf("task %s is not installed", Task)
	}
	Stop(exe)
	return schtasks("/Delete", "/F", "/TN", Task)
}

// Installed reports whether the logon task exists.
func Installed() bool {
	return Supported() && exec.Command("schtasks", "/Query", "/TN", Task).Run() == nil
}

// Start runs the task now.
func Start() error { return schtasks("/Run", "/TN", Task) }

// Stop ends the task (its console window) and any gateway running from exe,
// except this process. Best effort: nothing running is fine.
func Stop(exe string) {
	if !Supported() {
		return
	}
	exec.Command("schtasks", "/End", "/TN", Task).Run()
	// The task's cmd /k is the parent; make sure the gateway itself is gone too,
	// including one started by an older install.ps1 (no task).
	ps := fmt.Sprintf("Get-Process | Where-Object { $_.Path -eq '%s' -and $_.Id -ne %d } | Stop-Process -Force",
		strings.ReplaceAll(exe, "'", "''"), os.Getpid())
	exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", ps).Run()
}

func schtasks(args ...string) error {
	out, err := exec.Command("schtasks", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("schtasks %s: %v: %s", args[0], err, bytes.TrimSpace(out))
	}
	return nil
}

// TaskXML is the task definition. XML instead of schtasks flags because the
// flags can't turn off the 72 h run limit or the battery rules, and an ONLOGON
// trigger for the current user only works without admin rights via XML.
// schtasks reads UTF-16 reliably, hence the BOM + UTF-16LE.
func TaskXML(userID, exe, dir string) []byte {
	esc := func(s string) string {
		var b strings.Builder
		xml.EscapeText(&b, []byte(s))
		return b.String()
	}
	doc := `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>StreamIQ gateway (gateway service uninstall removes it)</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>` + esc(userID) + `</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>` + esc(userID) + `</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec>
    <Command>cmd.exe</Command>
    <Arguments>` + esc(`/k ""`+exe+`" run"`) + `</Arguments>
    <WorkingDirectory>` + esc(dir) + `</WorkingDirectory>
  </Exec></Actions>
</Task>
`
	u := utf16.Encode([]rune(doc))
	out := make([]byte, 2, 2+2*len(u))
	binary.LittleEndian.PutUint16(out, 0xFEFF)
	for _, c := range u {
		out = binary.LittleEndian.AppendUint16(out, c)
	}
	return out
}
