// gateway update / rollback, the update notice and the web app's remote update.

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"streamiq/gateway/internal/jellyfin"
	"streamiq/gateway/internal/service"
	"streamiq/gateway/internal/update"
)

// selfUpdate installs the latest release over exe (the user, or a remote update: startUpdater) and
// restarts the logon task if there is one.
func selfUpdate(ctx context.Context, exe string) error {
	if !service.Supported() {
		return service.ErrUnsupported
	}
	latest, ok, err := checkUpdate(ctx, version, env("STREAMIQ_LATEST", update.LatestURL))
	if err != nil || !ok {
		return err
	}
	fmt.Printf("Downloading v%s…\n", latest)
	if err = update.Download(
		ctx,
		env("STREAMIQ_DOWNLOAD", update.DownloadURL),
		update.Asset(),
		exe+".new",
		terminal(os.Stdout),
	); err != nil {
		return err
	}
	keep, err := backupBefore(ctx, exe)
	if err != nil {
		return err
	}
	os.Remove(exe + ".old") // left by a rollback, or an older release's update
	task := service.Installed(exe)
	if err := swap(exe, keep, task, service.Stop, func() error { return service.Start(exe) }); err != nil {
		return err
	}
	fmt.Print(updated(version, latest, keep, task))
	return nil
}

// terminal is f when it's a console, else nil: a remote update's update.log
// gets no progress line.
func terminal(f *os.File) io.Writer {
	if fi, err := f.Stat(); err == nil && fi.Mode()&os.ModeCharDevice != 0 {
		return f
	}
	return nil
}

// checkUpdate says whether current should update to the release at url (latest),
// printing "Up to date" when not.
func checkUpdate(ctx context.Context, current, url string) (latest string, ok bool, err error) {
	if current == "dev" {
		return "", false, errors.New("dev build: rebuild it instead")
	}
	latest, err = update.Latest(ctx, url)
	if err != nil {
		return "", false, err
	}
	if !update.Newer(latest, current) {
		fmt.Printf("Up to date (v%s).\n", current)
		return latest, false, nil
	}
	return latest, true, nil
}

// backupBefore backs up the state with this (old) binary, before anything is
// replaced, into the dir it returns.
func backupBefore(ctx context.Context, exe string) (keep string, err error) {
	keep, err = update.BackupDir(filepath.Dir(exe), version, time.Now())
	if err == nil {
		_, err = writeBackup(
			ctx,
			filepath.Join(keep, update.StateZip),
			filepath.Join(filepath.Dir(exe), jellyfin.ComposeFile),
		)
	}
	if err != nil {
		return "", backupFailed(exe, keep, err)
	}
	return keep, nil
}

// backupFailed removes what the update made so far: the download and the backup dir.
func backupFailed(exe, keep string, err error) error {
	os.Remove(exe + ".new")
	if keep != "" {
		os.RemoveAll(keep)
	}
	return fmt.Errorf("backup before the update failed, nothing changed: %w", err)
}

// swap puts exe.new in place of exe, moving exe into keep. With a logon task it
// stops it first and starts it again even if the swap failed; the swap's error wins.
func swap(exe, keep string, task bool, stop func(exe string), start func() error) error {
	if task {
		stop(exe)
	}
	kept := filepath.Join(keep, filepath.Base(exe))
	err := update.Swap(exe, exe+".new", kept)
	if err == nil {
		if perr := update.Prune(filepath.Dir(exe)); perr != nil { // the update itself is done
			fmt.Fprintln(os.Stderr, "gateway: removing old backups:", perr)
		}
	} else if _, serr := os.Stat(kept); errors.Is(serr, os.ErrNotExist) {
		// exe is back in place: nothing changed, and a backup without its binary
		// is no rollback point that Prune should count
		os.Remove(exe + ".new")
		os.RemoveAll(keep)
	}
	if task {
		if serr := start(); err == nil {
			err = serr
		}
	}
	return err
}

// updated is what a successful update prints.
func updated(old, latest, keep string, task bool) string {
	s := fmt.Sprintf("Updated v%s → v%s. Restart the gateway to run it (or: gateway service install).\n", old, latest)
	if task {
		s = fmt.Sprintf("Updated v%s → v%s and restarted.\n", old, latest)
	}
	return s + fmt.Sprintf("v%s and its state are kept in %s: gateway rollback goes back to it.\n", old, keep)
}

// startUpdater runs `gateway update` for a remote update, detached so it
// outlives the logon task it stops; its output goes to update.log next to the binary.
func startUpdater() (wait func(), err error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(filepath.Dir(exe), "update.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	fmt.Fprintf(f, "%s remote update from the web app\n", time.Now().Format(time.RFC3339))
	c := exec.Command(exe, "update") // same working dir as this gateway: a relative state dir stays the same
	c.Stdout, c.Stderr = f, f
	service.Detach(c)
	if err := c.Start(); err != nil {
		f.Close()
		return nil, err
	}
	slog.Info("gateway: remote update started", "pid", c.Process.Pid, "log", f.Name())
	return func() {
		if err := c.Wait(); err != nil {
			slog.Warn("gateway: remote update failed", "err", err, "log", f.Name())
		}
		f.Close()
	}, nil
}

// remoteUpdate is /streamiq/status's remoteUpdate: true, or why not.
func remoteUpdate(r *update.Remote) any {
	if why := r.Reason(); why != "" {
		return why
	}
	return true
}

// rollback puts back the binary and state the last update replaced:
// stop, restore the state with the kept binary (it knows its own format), swap
// the binaries, start.
func rollback(ctx context.Context, exe string) error {
	install := filepath.Dir(exe)
	dir, prev, err := update.Previous(install, filepath.Base(exe))
	if err != nil {
		return err
	}
	kept := filepath.Join(dir, filepath.Base(exe))
	task := service.Installed(exe)
	stopGateway(exe)
	if err = waitStopped(); err != nil {
		return err
	}
	c := exec.CommandContext(ctx, kept, "restore", "--force", filepath.Join(dir, update.StateZip))
	c.Dir, c.Stdout, c.Stderr = install, io.Discard, os.Stderr
	if err = c.Run(); err != nil {
		return fmt.Errorf("restoring the state with %s: %w (nothing changed; start the gateway again)", kept, err)
	}
	if err = update.Swap(exe, kept, exe+".old"); err != nil {
		return fmt.Errorf(
			"the state of %s is restored, but its binary could not be put back: %w (copy %s over %s by hand)",
			prev,
			err,
			kept,
			exe,
		)
	}
	os.Remove(exe + ".old") // Windows: still running (this process); the next update removes it
	os.RemoveAll(dir)       // used up: a second rollback goes one update further back
	fmt.Printf("Rolled back %s → %s.\n", version, prev)
	if task || runtime.GOOS != "windows" {
		if err = startGateway(exe, task); err == nil {
			fmt.Println("Started it again.")
		}
		return err
	}
	fmt.Println("Start it: gateway service install")
	return nil
}

// startGateway starts exe as it ran: the logon task (task), else as install.sh
// does. Not for Windows without the task (a gateway started by hand).
func startGateway(exe string, task bool) error {
	if task {
		return service.Start(exe)
	}
	return exec.Command("sh", "-c", `cd "$1" && nohup "$2" >> "$1/gateway.log" 2>&1 &`, "sh", filepath.Dir(exe), exe).
		Run()
}

func waitStopped() error {
	for i := 0; notRunning() != nil; i++ {
		if i == 20 {
			return notRunning()
		}
		time.Sleep(500 * time.Millisecond)
	}
	return nil
}

// restartGateway restarts a gateway running from exe (not this process) so it
// reads gateway.env again; one started by hand on Windows is left to the user.
func restartGateway(exe string) error {
	task := service.Installed(exe)
	if !task && runtime.GOOS == "windows" {
		fmt.Println("Restart the gateway to apply it: close its window and start it again (gateway run).")
		return nil
	}
	stopGateway(exe)
	if err := waitStopped(); err != nil {
		return err
	}
	if err := startGateway(exe, task); err != nil {
		return err
	}
	fmt.Println("Restarted the gateway.")
	return nil
}

// stopGateway ends a gateway running from exe (not this process): the logon
// task on Windows, else the pid in exe.pid, and what install.sh started (its
// pkill pattern) for a gateway older than the pid file. install.sh does the same.
func stopGateway(exe string) {
	if runtime.GOOS == "windows" {
		service.Stop(exe)
		return
	}
	if pid, ok := gatewayPid(exe); ok {
		p, _ := os.FindProcess(pid) // never fails on Unix
		_ = p.Signal(syscall.SIGTERM)
	}
	// best effort: pkill fails when nothing matches, and nothing running is fine
	_ = exec.Command("pkill", "-f", "^"+regexp.QuoteMeta(exe)+"$").Run()
}

// gatewayPid is the pid in exe.pid while a process named gateway has it: a
// stale file whose pid now belongs to another program names nothing.
func gatewayPid(exe string) (int, bool) {
	b, err := os.ReadFile(exe + ".pid")
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 1 || pid == os.Getpid() {
		return 0, false
	}
	// Linux: /proc (BusyBox ps has no -p); macOS: ps comm is the started path (./gateway, /…/gateway)
	comm, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/comm")
	if errors.Is(err, os.ErrNotExist) && runtime.GOOS == "darwin" {
		comm, err = exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "comm=").Output()
	}
	return pid, err == nil && filepath.Base(strings.TrimSpace(string(comm))) == filepath.Base(exe)
}

// checkUpdates asks GitHub for the latest release at start, then daily, and
// publishes a notice (log + local page) when it's newer. Dev builds skip it.
func checkUpdates(ctx context.Context, notice, newer *atomic.Pointer[string]) {
	if version == "dev" {
		return
	}
	for {
		latest, err := update.Latest(ctx, env("STREAMIQ_LATEST", update.LatestURL))
		if err != nil {
			slog.Warn("gateway: release check failed", "err", err)
		} else if update.Newer(latest, version) {
			msg := fmt.Sprintf("v%s → v%s. Run: %s", version, latest, update.Command())
			notice.Store(&msg)
			newer.Store(&latest)
			slog.Warn("gateway: update available " + msg)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(24 * time.Hour):
		}
	}
}
