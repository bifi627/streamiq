package jellyfin

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Jellyfin's backup API (#298) on the Jellyfin the gateway set up with
// jellyfin-compose.yml. Jellyfin has no download or upload endpoint: archives
// live in its BackupPath, which the compose file's ./jellyfin-config bind
// mount puts next to the binary. The container writes them as root (Linux),
// so the gateway adds and removes them inside the container (docker compose
// cp/exec), never by host file access; it only reads them on the host.

const (
	backupDir   = "/config/data/backups" // Jellyfin's BackupPath in the container
	restoreName = "streamiq-restore.zip" // the archive's name while a restore runs
	service     = "jellyfin"             // the service in jellyfin-compose.yml
	opTimeout   = 30 * time.Minute       // Backup/Create on a large database; a restore's restart
)

var archiveName = regexp.MustCompile(`^[A-Za-z0-9._-]+\.zip$`)

// CreateBackup has Jellyfin write a database-only backup (no metadata, trickplay
// or subtitles) and returns that archive's host path and a func that removes it
// from Jellyfin's backup folder. An error is the reason Jellyfin's data stays out
// of the gateway backup: only the Jellyfin the gateway set up (managed) and runs
// with compose, whose archive turns up under that install dir's jellyfin-config.
// One sign-in, no retry: Jellyfin locks users out after failed sign-ins.
func (s *Setup) CreateBackup(ctx context.Context, compose string) (archive string, remove func(), err error) {
	if err := s.Load(); err != nil {
		return "", nil, err
	}
	c := s.View()
	if !c.Managed {
		return "", nil, errors.New("the gateway didn't set this Jellyfin up (back it up in Jellyfin: Dashboard → Backups)")
	}
	config := filepath.Join(filepath.Dir(compose), "jellyfin-config")
	if _, err := os.Stat(compose); err != nil {
		return "", nil, fmt.Errorf("no %s next to the gateway (back Jellyfin up in Jellyfin: Dashboard → Backups)", ComposeFile)
	}
	if _, err := os.Stat(config); err != nil {
		return "", nil, fmt.Errorf("no %s: Jellyfin doesn't keep its data next to %s", config, ComposeFile)
	}
	s.mu.Lock()
	user, pw := s.creds.User, s.creds.Password
	s.mu.Unlock()
	admin, err := s.signIn(ctx, user, pw)
	if unauthorized(err) {
		return "", nil, fmt.Errorf("Jellyfin refused the %s password stored in %s (changed in Jellyfin? Store the new one with `gateway jellyfin login`)", user, s.path())
	} else if err != nil {
		return "", nil, fmt.Errorf("Jellyfin not reachable at %s: %w", s.URL, err)
	}
	defer s.call(context.WithoutCancel(ctx), "POST", "/Sessions/Logout", admin, "", nil)
	var m struct{ Path string }
	if err := s.callT(ctx, opTimeout, "POST", "/Backup/Create", admin,
		`{"Metadata":false,"Trickplay":false,"Subtitles":false,"Database":true}`, &m); err != nil {
		return "", nil, fmt.Errorf("Jellyfin's backup failed: %w", err)
	}
	base := path.Base(m.Path) // a container path
	if !archiveName.MatchString(base) {
		return "", nil, fmt.Errorf("Jellyfin named its backup %q", m.Path)
	}
	archive = filepath.Join(config, "data", "backups", base)
	if _, err := os.Stat(archive); err != nil {
		return "", nil, fmt.Errorf("Jellyfin's backup %s is not in %s: %s doesn't run this Jellyfin? (Jellyfin keeps the archive)", base, filepath.Dir(archive), ComposeFile)
	}
	return archive, func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
		defer cancel()
		if err := composeQuiet(ctx, compose, "exec", "-T", service, "rm", "-f", backupDir+"/"+base); err != nil {
			fmt.Fprintf(os.Stderr, "Could not remove Jellyfin's copy %s: %v\n", archive, err)
		}
	}, nil
}

// RestoreCLI is `gateway jellyfin restore`: puts archive (a Jellyfin backup the
// gateway made) back into the managed Jellyfin, then writes creds (that
// backup's jellyfin.json) into the state dir, only once the restored Jellyfin
// accepts its admin password. The gateway must not run (it rewrites jellyfin.json).
func RestoreCLI(ctx context.Context, s *Setup, compose, archive string, creds []byte, out io.Writer) error {
	var bc Creds
	if err := json.Unmarshal(creds, &bc); err != nil || !bc.managed() {
		return errors.New("the backup's jellyfin.json has no admin of the gateway's own")
	}
	if _, err := os.Stat(compose); err != nil {
		return fmt.Errorf("no %s: run `gateway jellyfin up` first", compose)
	}
	fmt.Fprintln(out, "This replaces Jellyfin's users, libraries and watch state with the backup's.")
	var info struct {
		Version                string
		StartupWizardCompleted bool
	}
	if err := s.call(ctx, "GET", "/System/Info/Public", "", "", &info); err != nil {
		return fmt.Errorf("Jellyfin not reachable at %s (start it: gateway jellyfin up): %w", s.URL, err)
	}
	if !info.StartupWizardCompleted {
		fmt.Fprintln(out, "Completing Jellyfin's setup wizard (an admin for its backup API)…")
		// A Jellyfin just started answers 503 for a while: retried, nothing is done until it doesn't.
		err := s.bootstrap(ctx)
		for deadline := time.Now().Add(2 * time.Minute); status(err) == http.StatusServiceUnavailable && time.Now().Before(deadline); err = s.bootstrap(ctx) {
			time.Sleep(2 * time.Second)
		}
		if err != nil {
			return fmt.Errorf("Jellyfin setup: %w", err)
		}
	} else if err := s.Load(); err != nil {
		return err
	}
	if v := backupVersion(archive); v != "" && version3(v) != version3(info.Version) {
		fmt.Fprintf(out, "Warning: the backup is from Jellyfin %s, this one runs %s. Jellyfin may refuse it or migrate it.\n", v, info.Version)
	}
	s.mu.Lock()
	cur := s.creds
	s.mu.Unlock()
	// The current admin, else the backup's (a Jellyfin restored before). One try each: lockouts.
	logins := [][2]string{{cur.User, cur.Password}}
	if cur.User != bc.User || cur.Password != bc.Password {
		logins = append(logins, [2]string{bc.User, bc.Password})
	}
	var admin string
	err := errors.New("the gateway has no admin password for this Jellyfin (`gateway jellyfin login` stores one)")
	for _, l := range logins {
		if l[1] == "" {
			continue
		}
		if admin, err = s.signIn(ctx, l[0], l[1]); err == nil {
			break
		}
	}
	if err != nil {
		return err
	}
	if err := composeQuiet(ctx, compose, "exec", "-T", service, "mkdir", "-p", backupDir); err != nil {
		return err
	}
	if err := composeQuiet(ctx, compose, "cp", archive, service+":"+backupDir+"/"+restoreName); err != nil {
		return err
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
		defer cancel()
		_ = composeQuiet(ctx, compose, "exec", "-T", service, "rm", "-f", backupDir+"/"+restoreName)
	}()
	logs := fmt.Sprintf("see Jellyfin's log: docker compose -f %q logs %s", compose, service)
	fmt.Fprintln(out, "Restoring; Jellyfin restarts…")
	if err := s.call(ctx, "POST", "/Backup/Restore", admin, fmt.Sprintf(`{"ArchiveFileName":%q}`, restoreName), nil); err != nil {
		return fmt.Errorf("Jellyfin refused the restore (%w); %s", err, logs)
	}
	if err := s.awaitRestored(ctx, bc, opTimeout); err != nil {
		return fmt.Errorf("%w; %s. The gateway's Jellyfin login (%s) is unchanged", err, logs, s.path())
	}
	if err := os.WriteFile(s.path(), creds, 0o600); err != nil {
		return err
	}
	if err := os.Chmod(s.path(), 0o600); err != nil { // WriteFile keeps an existing file's mode
		return err
	}
	fmt.Fprintf(out, "Restored Jellyfin and wrote the backup's Jellyfin login to %s.\n", s.path())
	fmt.Fprintln(out, "Start the gateway. Posters and images come back with a library scan (Jellyfin: Dashboard → Libraries → Scan All Libraries).")
	return nil
}

// awaitRestored waits for Jellyfin to go down for the restore and come back,
// then signs in once as the backup's admin. A refusal is final (lockouts).
func (s *Setup) awaitRestored(ctx context.Context, bc Creds, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	down := false
	for {
		up := s.call(ctx, "GET", "/System/Info/Public", "", "", nil) == nil
		down = down || !up
		if down && up {
			tok, err := s.signIn(ctx, bc.User, bc.Password)
			if err == nil {
				s.call(ctx, "POST", "/Sessions/Logout", tok, "", nil)
				return nil
			}
			if unauthorized(err) {
				return fmt.Errorf("the restored Jellyfin refused the backup's %s password: the restore did not take", bc.User)
			}
		}
		select {
		case <-ctx.Done():
			return errors.New("Jellyfin did not come back with the backup in time")
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// backupVersion is the ServerVersion in a Jellyfin archive's manifest.json, "" if unreadable.
func backupVersion(archive string) string {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return ""
	}
	defer zr.Close()
	f, err := zr.Open("manifest.json")
	if err != nil {
		return ""
	}
	defer f.Close()
	var m struct{ ServerVersion string }
	_ = json.NewDecoder(io.LimitReader(f, 1<<20)).Decode(&m)
	return m.ServerVersion
}

// version3 is major.minor.patch: the manifest says 12.4.0.0, the server 12.4.0.
func version3(v string) string {
	p := strings.SplitN(v, ".", 4)
	return strings.Join(p[:min(3, len(p))], ".")
}
