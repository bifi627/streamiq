// StreamIQ gateway. Wiring only — each feature lives in its own package under
// internal/ (vertical slices):
//
//	identity    persistent DTLS certificate + fingerprint (browsers pin it)
//	onboarding  enrollment token → credential, control socket + heartbeat
//	pairing     client-key auth, comparison code, allowlist + pending approvals
//	sessions    brokered browser sessions: auth channel, gated tunnel
//	localpage   the gateway's status page on the home LAN (approve / remove browsers)
//	jellyfin    non-admin Jellyfin viewer token without manual steps; transcoding settings; version check;
//	            `gateway jellyfin up|upgrade|offline|gpu` (Docker compose); `gateway jellyfin login` (repair, #241);
//	            `gateway jellyfin restore` (Jellyfin's backup API, #298)
//	tunnel      HTTP over data channels to Jellyfin (allowlist, token injection)
//	update      "newer release available" notice; `gateway update` swaps the binary,
//	            keeping the old one + a state backup in backups/ for `gateway rollback` (#296)
//	service     Windows logon task (`gateway service install|uninstall`)
//	backup      `gateway backup` / `gateway restore`: the state dir + jellyfin-compose.yml + Jellyfin's
//	            database as one zip (#52, #297, #298)
//
// Commands: cobra, in commands.go (gateway -h lists them).
//
// Config (env, or gateway.env next to the binary / in the working dir; real
// env wins): STREAMIQ_API_URL (required), STREAMIQ_ENROLL_TOKEN, STREAMIQ_NAME, STREAMIQ_STATE_DIR,
// STREAMIQ_PAGE_PORT, STREAMIQ_LAN_URL, STREAMIQ_ORIGIN, STREAMIQ_JELLYFIN_HWACCEL, STREAMIQ_ICE_* (STREAMIQ_ICE_PORT:
// Docker, see sessions.NewAPI).
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/spf13/cobra"

	"streamiq/gateway/internal/backup"
	"streamiq/gateway/internal/identity"
	"streamiq/gateway/internal/jellyfin"
	"streamiq/gateway/internal/localpage"
	"streamiq/gateway/internal/onboarding"
	"streamiq/gateway/internal/pairing"
	"streamiq/gateway/internal/service"
	"streamiq/gateway/internal/sessions"
	"streamiq/gateway/internal/tunnel"
	"streamiq/gateway/internal/update"
)

// version is set at build time (-ldflags -X main.version=…; see Dockerfile).
var version = "dev"

func main() {
	// JSON logs; the stdlib log package routes through this too.
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	exe, err := os.Executable()
	if err == nil {
		loadEnvFile(filepath.Join(filepath.Dir(exe), "gateway.env")) // installed
	}
	loadEnvFile("gateway.env") // dev: gateway/gateway.env from scripts/setup-jellyfin.sh

	cobra.MousetrapHelpText = "" // started from Explorer (double-click): run the gateway, as before
	cmd, err := newRoot(ctx, exe).ExecuteC()
	if err == nil {
		return
	}
	fmt.Fprintln(os.Stderr, "gateway:", err)
	if errors.As(err, new(usageError)) {
		fmt.Fprint(os.Stderr, "\n"+cmd.UsageString())
		os.Exit(2)
	}
	os.Exit(1)
}

func stateDir() string { return env("STREAMIQ_STATE_DIR", "streamiq-state") }
func pagePort() string { return env("STREAMIQ_PAGE_PORT", "8097") }               // Jellyfin owns 8096
func origin() string   { return env("STREAMIQ_ORIGIN", "http://localhost:8096") } // local Jellyfin

// serviceInstall enrolls first if needed (a scheduled task doesn't inherit the
// installer's env, so the token is spent here and never stored), then installs
// and starts the logon task.
func serviceInstall(ctx context.Context, exe string) error {
	if !service.Supported() {
		return service.ErrUnsupported
	}
	_, fp, err := identity.LoadOrCreate(stateDir())
	if err != nil {
		return err
	}
	api := strings.TrimRight(os.Getenv("STREAMIQ_API_URL"), "/")
	st, err := onboarding.LoadOrEnroll(ctx, stateDir(), api, os.Getenv("STREAMIQ_ENROLL_TOKEN"), fp)
	if err != nil {
		return err
	}
	if err := service.Install(exe); err != nil {
		return err
	}
	fmt.Printf("Gateway %q runs now and at every logon, in its own console window (task %s).\n", st.Name, service.Task)
	return nil
}

// notRunning refuses while the local page answers: a running gateway holds its
// state in memory (and rewrites allowlist.json).
func notRunning() error {
	if c, err := net.DialTimeout("tcp", "127.0.0.1:"+pagePort(), time.Second); err == nil {
		c.Close()
		return fmt.Errorf("the gateway is running (port %s answers): stop it first (Windows: gateway service uninstall, or close its window)", pagePort())
	}
	return nil
}

// resetIdentity replaces the DTLS cert and clears the allowlist.
func resetIdentity() error {
	if err := notRunning(); err != nil {
		return err
	}
	fp, err := identity.Reset(stateDir())
	if err != nil {
		return err
	}
	fmt.Printf("New gateway identity %s.\n", fp)
	fmt.Println("Paired browsers were removed: each one shows a pairing code on its next connect; approve it on the local gateway page.")
	fmt.Println("Start the gateway again (gateway service install, or gateway run).")
	return nil
}

func jellyfinSetup() *jellyfin.Setup {
	return &jellyfin.Setup{Client: &http.Client{}, URL: origin(), // timeouts per request (Backup/Create: long)
		StateDir: stateDir(), OnKey: func(string, string) {}}
}

// backupState writes the backup zip (0600, never over an existing file), with
// Jellyfin's database when the gateway set Jellyfin up; else it says why not.
func backupState(ctx context.Context, file, compose string) error {
	jerr, err := writeBackup(ctx, file, compose)
	if err != nil {
		return err
	}
	abs, _ := filepath.Abs(file)
	fmt.Printf("Wrote %s.\n", abs)
	if jerr != nil {
		fmt.Println("!! Jellyfin's data (users, libraries, watch state) is NOT in it:", jerr)
	} else {
		fmt.Println("It includes Jellyfin's database (users, libraries, watch state): gateway jellyfin restore puts it back.")
	}
	fmt.Println()
	fmt.Println("!! This file is NOT encrypted. Whoever has it can pose as your gateway.")
	fmt.Println("!! Keep it like a password: not in a shared or synced folder, not in email.")
	fmt.Println("!! If it leaks: docs/install.md, \"If the gateway or a backup of its state may have leaked\".")
	fmt.Println()
	fmt.Println("To restore (docs/install.md, \"Back up and restore the gateway\"), stop the old gateway first")
	fmt.Println("(two copies fight over the connection), then:")
	fmt.Printf("  new machine:  the install command with STREAMIQ_API_URL and STREAMIQ_RESTORE=%s, no enroll token\n", filepath.Base(file))
	fmt.Printf("  same install: stop the gateway, run gateway restore %s, start it again\n", filepath.Base(file))
	if jerr == nil {
		fmt.Printf("  Jellyfin:     with the gateway stopped, gateway jellyfin restore %s (the order is in docs/install.md)\n", filepath.Base(file))
	}
	return nil
}

// writeBackup writes the zip; jerr says why Jellyfin's database is not in it.
func writeBackup(ctx context.Context, file, compose string) (jerr, err error) {
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return nil, fmt.Errorf("%s already exists: name another file (gateway backup <file>)", file)
	} else if err != nil {
		return nil, err
	}
	archive, remove, jerr := jellyfinSetup().CreateBackup(ctx, compose)
	if remove != nil {
		defer remove()
	}
	err = backup.Write(stateDir(), compose, archive, f)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(file)
	}
	return jerr, err
}

// restoreState unpacks a backup into the state dir (and its compose file next to the binary).
func restoreState(file, compose string, force bool) error {
	if err := notRunning(); err != nil {
		return err
	}
	did, err := backup.Restore(file, stateDir(), compose, force)
	if err != nil {
		return err
	}
	abs, _ := filepath.Abs(stateDir())
	fmt.Printf("Restored the gateway into %s.\n", abs)
	switch did {
	case backup.ComposeWritten:
		fmt.Printf("Wrote %s from the backup.\n", compose)
		fmt.Println("On a new machine its media folder paths may be wrong: check them before gateway jellyfin up.")
	case backup.ComposeKept:
		fmt.Printf("Kept the existing %s (the backup's copy is not used).\n", compose)
		fmt.Println("On a new machine check its media folder paths before gateway jellyfin up.")
	}
	fmt.Println("Start it (gateway service install, or gateway run): it comes back as the same gateway, paired browsers included.")
	return nil
}

// jellyfinRestore puts a backup's Jellyfin data back into the managed Jellyfin.
func jellyfinRestore(ctx context.Context, file, compose string) error {
	if err := notRunning(); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp("", "streamiq-restore-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	archive := filepath.Join(tmp, "jellyfin-backup.zip")
	creds, err := backup.ExtractJellyfin(file, archive)
	if err != nil {
		return err
	}
	return jellyfin.RestoreCLI(ctx, jellyfinSetup(), compose, archive, creds, os.Stdout)
}

// jellyfinUp downloads the release's compose file next to the binary unless the
// user already has one (it's theirs from then on), then starts Jellyfin.
func jellyfinUp(ctx context.Context, file string) error {
	if _, err := os.Stat(file); errors.Is(err, os.ErrNotExist) {
		if err := update.Download(ctx, env("STREAMIQ_DOWNLOAD", update.DownloadURL), jellyfin.ComposeFile, file); err != nil {
			return err
		}
		// Its default bind; compose refuses a missing bind source.
		if err := os.MkdirAll(filepath.Join(filepath.Dir(file), "media"), 0o755); err != nil {
			return err
		}
		fmt.Printf("Downloaded %s. Point its media folders at yours, then run `gateway jellyfin up` again.\n", file)
	}
	return jellyfin.Compose(ctx, file, "up", "-d")
}

// selfUpdate installs the latest release over exe (the user, or a remote update: startUpdater) and
// restarts the logon task if there is one.
func selfUpdate(ctx context.Context, exe string) error {
	if !service.Supported() {
		return service.ErrUnsupported
	}
	if version == "dev" {
		return errors.New("dev build: rebuild it instead")
	}
	latest, err := update.Latest(ctx, update.LatestURL)
	if err != nil {
		return err
	}
	if !update.Newer(latest, version) {
		fmt.Printf("Up to date (v%s).\n", version)
		return nil
	}
	fmt.Printf("Downloading v%s…\n", latest)
	if err := update.Download(ctx, env("STREAMIQ_DOWNLOAD", update.DownloadURL), update.Asset(), exe+".new"); err != nil {
		return err
	}
	// This (old) binary backs up its own state, before anything is replaced (#296).
	keep, err := update.BackupDir(filepath.Dir(exe), version, time.Now())
	if err == nil {
		_, err = writeBackup(ctx, filepath.Join(keep, update.StateZip), filepath.Join(filepath.Dir(exe), jellyfin.ComposeFile))
	}
	if err != nil {
		os.Remove(exe + ".new")
		if keep != "" {
			os.RemoveAll(keep)
		}
		return fmt.Errorf("backup before the update failed, nothing changed: %w", err)
	}
	os.Remove(exe + ".old") // left by a rollback, or an update before #296
	task := service.Installed()
	if task {
		service.Stop(exe)
	}
	err = update.Swap(exe, exe+".new", filepath.Join(keep, filepath.Base(exe)))
	if err == nil {
		if perr := update.Prune(filepath.Dir(exe)); perr != nil { // the update itself is done
			fmt.Fprintln(os.Stderr, "gateway: removing old backups:", perr)
		}
	}
	if task {
		if serr := service.Start(); err == nil {
			err = serr
		}
	}
	if err != nil {
		return err
	}
	if task {
		fmt.Printf("Updated v%s → v%s and restarted.\n", version, latest)
	} else {
		fmt.Printf("Updated v%s → v%s. Restart the gateway to run it (or: gateway service install).\n", version, latest)
	}
	fmt.Printf("v%s and its state are kept in %s: gateway rollback goes back to it.\n", version, keep)
	return nil
}

// startUpdater runs `gateway update` for a remote update (#312), detached so it
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
	return func() { c.Wait(); f.Close() }, nil
}

// remoteUpdate is /streamiq/status's remoteUpdate: true, or why not.
func remoteUpdate(r *update.Remote) any {
	if why := r.Reason(); why != "" {
		return why
	}
	return true
}

// rollback puts back the binary and state the last update replaced (#296):
// stop, restore the state with the kept binary (it knows its own format), swap
// the binaries, start.
func rollback(ctx context.Context, exe string) error {
	install := filepath.Dir(exe)
	dir, prev, err := update.Previous(install, filepath.Base(exe))
	if err != nil {
		return err
	}
	kept := filepath.Join(dir, filepath.Base(exe))
	task := service.Installed()
	stopGateway(exe)
	if err := waitStopped(); err != nil {
		return err
	}
	c := exec.CommandContext(ctx, kept, "restore", "--force", filepath.Join(dir, update.StateZip))
	c.Dir, c.Stdout, c.Stderr = install, io.Discard, os.Stderr
	if err := c.Run(); err != nil {
		return fmt.Errorf("restoring the state with %s: %w (nothing changed; start the gateway again)", kept, err)
	}
	if err := update.Swap(exe, kept, exe+".old"); err != nil {
		return fmt.Errorf("the state of %s is restored, but its binary could not be put back: %w (copy %s over %s by hand)", prev, err, kept, exe)
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
		return service.Start()
	}
	return exec.Command("sh", "-c", `cd "$1" && nohup "$2" >> "$1/gateway.log" 2>&1 &`, "sh", filepath.Dir(exe), exe).Run()
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
	task := service.Installed()
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
// task on Windows, else what install.sh started (its pkill pattern).
func stopGateway(exe string) {
	if runtime.GOOS == "windows" {
		service.Stop(exe)
		return
	}
	exec.Command("pkill", "-f", "^"+regexp.QuoteMeta(exe)+"$").Run()
}

// run is the gateway daemon; compose is jellyfin-compose.yml next to the binary.
func run(ctx context.Context, compose string) {
	stateDir := stateDir()
	cert, fp, err := identity.LoadOrCreate(stateDir)
	if err != nil {
		log.Fatalf("gateway: certificate: %v", err)
	}
	log.Printf("gateway: %s, state %s, DTLS fingerprint %s", version, stateDir, fp)

	// No Client.Timeout: it caps the whole body read, which would abort a long
	// stream mid-movie. ponytail: leaks a goroutine on a hung origin; a
	// per-request context with a header-only deadline is the upgrade path.
	// DisableCompression: a tunnel must be byte-transparent. Go's default
	// transport auto-adds Accept-Encoding: gzip, then silently decompresses —
	// which rewrites the body and drops Content-Length. Forward exactly what the
	// browser asked for and hand back exactly what the origin sent.
	jf := &tunnel.Jellyfin{
		// CheckRedirect: a redirect goes back to the browser as it is; the gateway
		// never follows one to a URL the allowlist did not see.
		Client: &http.Client{Transport: &http.Transport{DisableCompression: true},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		URL: origin(),
	}
	// Token: the stored one, else the setup loop gets one (fresh Jellyfin) or
	// the local page asks for an admin login.
	hw := os.Getenv("STREAMIQ_JELLYFIN_HWACCEL")
	if !slices.Contains(jellyfin.HWAccels, hw) {
		log.Fatalf("gateway: STREAMIQ_JELLYFIN_HWACCEL=%q, want one of %q", hw, jellyfin.HWAccels)
	}
	setup := &jellyfin.Setup{Client: &http.Client{}, URL: jf.URL, StateDir: stateDir, OnKey: jf.SetKey, HWAccel: hw}
	jf.Viewer = setup.ViewerFor
	if err := setup.Load(); err != nil {
		log.Fatalf("gateway: %v", err)
	}
	go setup.Run(ctx)
	if o := jellyfin.Offline(compose); o != "" { // #321; read again on each status request
		log.Printf("gateway: Jellyfin offline jail: %s (%s)", o, compose)
	}

	// Enroll once, then heartbeat over the authenticated control socket and
	// serve the local page.
	api := strings.TrimRight(os.Getenv("STREAMIQ_API_URL"), "/")
	if api == "" {
		log.Fatal("gateway: STREAMIQ_API_URL not set (use the install command from the web app)")
	}
	{
		st, err := onboarding.LoadOrEnroll(ctx, stateDir, api, os.Getenv("STREAMIQ_ENROLL_TOKEN"), fp)
		if err != nil {
			log.Fatalf("gateway: %v", err)
		}
		log.Printf("gateway: id %s (%s)", st.GatewayID, st.Name)
		port := pagePort()
		lan := onboarding.LANURL(port)
		lanHost := ""
		if u, err := url.Parse(lan); err == nil {
			lanHost = u.Hostname()
		}
		store, err := pairing.Open(stateDir)
		if err != nil {
			log.Fatalf("gateway: allowlist: %v", err)
		}
		webAPI, err := sessions.NewAPI()
		if err != nil {
			log.Fatalf("gateway: ICE: %v", err)
		}
		sess := &sessions.Sessions{Cert: cert, Fp: fp, Store: store, Jellyfin: jf, API: webAPI,
			Viewers: func(user string) {
				ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
				defer cancel()
				setup.EnsureViewer(ctx, user)
			}}
		store.OnRemove = sess.Drop // removing a browser ends its open sessions
		jf.Clients = store         // gateway API /streamiq/clients (#311)
		var lastBeat atomic.Int64
		var notice, newer atomic.Pointer[string]
		notice.Store(new(string))
		newer.Store(new(string))
		go checkUpdates(ctx, &notice, &newer)
		remote := &update.Remote{Version: version, Supported: service.Supported(), Task: service.Installed,
			Newer: func() string { return *newer.Load() }, Start: startUpdater}
		jf.Update = func() (string, error) { // gateway API POST /streamiq/update (#312)
			v, refused, err := remote.Run()
			if refused != "" {
				return "", tunnel.Conflict(refused)
			}
			return v, err
		}
		started := time.Now().UTC()
		jf.Rename = func(name string) (string, error) { // gateway API POST /streamiq/name (#310)
			n, err := st.SetName(name)
			if errors.Is(err, onboarding.ErrBadName) {
				err = fmt.Errorf("%w: %w", tunnel.ErrBadRequest, err)
			}
			return n, err
		}
		jf.Status = func(user string) any { // gateway API GET /streamiq/status (docs/protocol.md)
			v := setup.View()
			jfs := map[string]any{"reachable": v.Reachable, "version": v.Version, "untested": v.Untested, "token": v.Token()}
			if o := jellyfin.Offline(compose); o != "" { // no compose Jellyfin: no field
				jfs["offline"] = o
			}
			return map[string]any{
				"transcoding": v.Transcoding(),
				"os":          runtime.GOOS, "arch": runtime.GOARCH, "startedAt": started,
				"jellyfin": jfs,
				// Counts only: no client names (#65).
				"pairedClients": len(store.Paired()), "activeSessions": sess.Active(),
				"viewer":       setup.ViewerState(user), // this session's own (#242)
				"remoteUpdate": remoteUpdate(remote),
			}
		}
		token, err := localpage.Token(stateDir, lan)
		if err != nil {
			log.Fatalf("gateway: page token: %v", err)
		}
		go func() {
			log.Printf("gateway: local page on %s (login link in %s)", lan, filepath.Join(stateDir, "page-link"))
			page := localpage.Handler(localpage.Config{
				Name: st.CurrentName, GatewayID: st.GatewayID, Fingerprint: fp, Version: version,
				LastBeat: &lastBeat, Update: &notice, Store: store,
				Jellyfin: func() any { return setup.View() }, Login: setup.Login,
				Offline:     func() string { return jellyfin.Offline(compose) },
				Libraries:   func(ctx context.Context) (any, error) { return setup.Libraries(ctx) },
				MakeOffline: setup.MakeOffline, SetExtras: setup.SetExtras,
			})
			log.Fatal(http.ListenAndServe(":"+port, localpage.Guard(lanHost, localpage.Auth(token, page))))
		}()
		go forever(ctx, func(ctx context.Context) error {
			return onboarding.RunControl(ctx, api, st, lan, version, &lastBeat, func() string { return *newer.Load() }, sess.Handle)
		})
	}

	<-ctx.Done()
}

// forever reruns fn until ctx ends. The API sockets are long-lived and
// mostly idle, and Railway's edge reaps idle sockets — so they WILL drop. A
// home gateway must survive that unattended, so reconnect with backoff instead
// of exiting. A session that stayed up a while resets the backoff; a
// fast-failing dial keeps backing off up to 30s. A refused protocol (#176) only
// changes with an update, so that retries every 10 minutes.
func forever(ctx context.Context, fn func(context.Context) error) {
	backoff := time.Second
	for ctx.Err() == nil {
		start := time.Now()
		err := fn(ctx)
		if err != nil {
			log.Printf("gateway: %v", err)
		}
		if ctx.Err() != nil {
			return // Ctrl+C
		}
		if time.Since(start) > 30*time.Second {
			backoff = time.Second // the connection was healthy; treat this as a fresh drop
		}
		wait := backoff
		if errors.Is(err, onboarding.ErrUpgradeRequired) {
			wait = 10 * time.Minute
		}
		log.Printf("gateway: reconnecting in %s", wait)
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

// checkUpdates asks GitHub for the latest release at start, then daily, and
// publishes a notice (log + local page) when it's newer. Dev builds skip it.
func checkUpdates(ctx context.Context, notice, newer *atomic.Pointer[string]) {
	if version == "dev" {
		return
	}
	for {
		latest, err := update.Latest(ctx, update.LatestURL)
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

// loadEnvFile sets KEY=VALUE lines from path (# comments, blank lines ok)
// without overriding variables already in the environment. Missing file = no-op.
func loadEnvFile(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		k, v, ok := strings.Cut(line, "=")
		if !ok || strings.HasPrefix(line, "#") {
			continue
		}
		if _, set := os.LookupEnv(strings.TrimSpace(k)); !set {
			os.Setenv(strings.TrimSpace(k), strings.TrimSpace(v))
		}
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
