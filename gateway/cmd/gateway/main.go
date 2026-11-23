// StreamIQ gateway. Wiring only: each feature is a package under internal/
// (docs/architecture.md).
//
// Commands: cobra, in commands.go (gateway -h lists them).
//
// Config (env, or gateway.env next to the binary / in the working dir; real
// env wins): every variable is in docs/install.md, "gateway.env" (check.sh enforces it).
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/spf13/cobra"

	"streamiq/gateway/internal/backup"
	"streamiq/gateway/internal/history"
	"streamiq/gateway/internal/host"
	"streamiq/gateway/internal/identity"
	"streamiq/gateway/internal/jellyfin"
	"streamiq/gateway/internal/localpage"
	"streamiq/gateway/internal/onboarding"
	"streamiq/gateway/internal/pairing"
	"streamiq/gateway/internal/screen"
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

	cobra.MousetrapHelpText = "" // started from Explorer (double-click): run the gateway, not a "use a terminal" notice
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
	fmt.Printf(
		"Gateway %q runs now and at every logon, in its own console window (task %s).\n",
		st.Name,
		service.Task(exe),
	)
	return nil
}

// notRunning refuses while the local page answers: a running gateway holds its
// state in memory (and rewrites allowlist.json).
func notRunning() error {
	if c, err := net.DialTimeout("tcp", "127.0.0.1:"+pagePort(), time.Second); err == nil {
		c.Close()
		return fmt.Errorf(
			"the gateway is running (port %s answers): stop it first (Windows: gateway service uninstall, or close its window)",
			pagePort(),
		)
	}
	return nil
}

// setRelay is "gateway relay on|off".
func setRelay(on bool) error {
	if err := notRunning(); err != nil {
		return err
	}
	if err := onboarding.SetRelayFile(stateDir(), on); err != nil {
		return err
	}
	if on {
		fmt.Println("Relay on: a client that can't connect directly goes through the relay (TURN).")
	} else {
		fmt.Println("Relay off: direct connections only. Clients behind carrier NAT (most cellular) or a strict NAT can't connect.")
	}
	fmt.Println("Start the gateway again (gateway service install, or gateway run).")
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
	fmt.Println(
		"Paired browsers were removed: each one shows a pairing code on its next connect; approve it on the local gateway page.",
	)
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
		fmt.Println(
			"It includes Jellyfin's database (users, libraries, watch state): gateway jellyfin restore puts it back.",
		)
	}
	fmt.Println()
	fmt.Println("!! This file is NOT encrypted. Whoever has it can pose as your gateway.")
	fmt.Println("!! Keep it like a password: not in a shared or synced folder, not in email.")
	fmt.Println("!! If it leaks: docs/install.md, \"If the gateway or a backup of its state may have leaked\".")
	fmt.Println()
	fmt.Println("To restore (docs/install.md, \"Back up and restore the gateway\"), stop the old gateway first")
	fmt.Println("(two copies fight over the connection), then:")
	fmt.Printf(
		"  new machine:  the install command with STREAMIQ_API_URL and STREAMIQ_RESTORE=%s, no enroll token\n",
		filepath.Base(file),
	)
	fmt.Printf("  same install: stop the gateway, run gateway restore %s, start it again\n", filepath.Base(file))
	if jerr == nil {
		fmt.Printf(
			"  Jellyfin:     with the gateway stopped, gateway jellyfin restore %s (the order is in docs/install.md)\n",
			filepath.Base(file),
		)
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
	fmt.Println(
		"Start it (gateway service install, or gateway run): it comes back as the same gateway, paired browsers included.",
	)
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
// user already has one (it's theirs from then on), names it after this gateway
// (instance), then starts Jellyfin.
func jellyfinUp(ctx context.Context, file string) error {
	if _, err := os.Stat(file); errors.Is(err, os.ErrNotExist) {
		if err := update.Download(
			ctx,
			env("STREAMIQ_DOWNLOAD", update.DownloadURL),
			jellyfin.ComposeFile,
			file,
			nil,
		); err != nil {
			return err
		}
		if err := instance(file); err != nil {
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

// instance writes this install's compose project (service.Name of its dir) and
// Jellyfin port (STREAMIQ_ORIGIN's) into the freshly downloaded compose file.
func instance(file string) error {
	b, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	port := "8096"
	if u, err := url.Parse(origin()); err == nil && u.Port() != "" {
		port = u.Port()
	}
	b = jellyfin.Instance(b, service.Name("streamiq-jellyfin", filepath.Dir(file)), port)
	return os.WriteFile(file, b, 0o644)
}

// gatewayAPI is the gateway API's route table (docs/protocol.md); burst +
// route are tunnel's own. status is GET /streamiq/status.
func gatewayAPI(st *onboarding.State, remote *update.Remote, store *pairing.Store, status http.Handler,
	health http.Handler, tunnels *history.Tunnels,
) *tunnel.Router {
	rt := tunnel.NewRouter()
	screen.Register(rt)
	rt.Handle("GET "+tunnel.StatusPath, status)
	rt.Handle("GET "+history.HealthPath, health)
	rt.Handle("GET "+history.TunnelsPath, http.HandlerFunc(tunnels.ServeList))
	rt.Handle("GET "+history.SummaryPath, http.HandlerFunc(tunnels.ServeSummary), tunnel.AdminOnly)
	rt.Handle("POST "+onboarding.NamePath, http.HandlerFunc(st.ServeName), tunnel.AdminOnly)
	rt.Handle("POST "+onboarding.RelayPath, http.HandlerFunc(st.ServeRelay), tunnel.AdminOnly)
	rt.Handle("POST "+update.Path, remote, tunnel.AdminOnly)
	rt.Handle("GET "+pairing.ClientsPath, http.HandlerFunc(store.ServeClients))
	rt.Handle("POST "+pairing.ClientsRemovePath, http.HandlerFunc(store.ServeRemove))
	rt.Handle("POST "+pairing.ClientsRenamePath, http.HandlerFunc(store.ServeRename))
	rt.Handle("POST "+pairing.ClientsProfilePath, http.HandlerFunc(store.ServeProfile))
	return rt
}

// histories are the gateway's own records in its state dir.
func histories(stateDir, gatewayID string) (*history.Health, *history.Tunnels) {
	dir := filepath.Join(stateDir, history.Dir)
	return &history.Health{Store: &history.Store{Dir: dir, Kind: "health", Days: history.HealthDays}, Version: version},
		&history.Tunnels{Store: &history.Store{Dir: dir, Kind: "tunnels", Days: history.TunnelDays}, Gateway: gatewayID}
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
	root := &tunnel.Root{Jellyfin: jf}
	if err := setup.Load(); err != nil {
		log.Fatalf("gateway: %v", err)
	}
	go setup.Run(ctx)
	if o := jellyfin.Offline(compose); o != "" {
		log.Printf("gateway: Jellyfin offline jail: %s (%s)", o, compose)
	}

	// Enroll once, then heartbeat over the authenticated control socket and
	// serve the local page.
	api := strings.TrimRight(os.Getenv("STREAMIQ_API_URL"), "/")
	if api == "" {
		log.Fatal("gateway: STREAMIQ_API_URL not set (use the install command from the web app)")
	}
	enrollAndServe(ctx, stateDir, api, compose, cert, fp, root, setup)

	<-ctx.Done()
}

// enrollAndServe enrolls once (or loads the stored credential), then serves the local page and keeps
// the control socket up in the background; run waits on ctx.
func enrollAndServe(ctx context.Context, stateDir, api, compose string, cert *webrtc.Certificate, fp string,
	root *tunnel.Root, setup *jellyfin.Setup,
) {
	st, err := onboarding.LoadOrEnroll(ctx, stateDir, api, os.Getenv("STREAMIQ_ENROLL_TOKEN"), fp)
	if err != nil {
		log.Fatalf("gateway: %v", err)
	}
	log.Printf("gateway: id %s (%s)", st.GatewayID, st.Name)
	port := pagePort()
	lan := onboarding.LANURL(port)
	lanHost := ""
	if u, _ := url.Parse(lan); u != nil {
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
	sess := &sessions.Sessions{Cert: cert, Fp: fp, Store: store, Root: root, API: webAPI, Relay: st.Relay,
		Viewers: func(user string) {
			viewerCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()
			setup.EnsureViewer(viewerCtx, user)
		}}
	health, tunnels := histories(stateDir, st.GatewayID)
	sess.Ended = tunnels.Ended
	store.OnRemove = sess.Drop // removing a browser ends its open sessions
	var lastBeat atomic.Int64
	var notice, newer atomic.Pointer[string]
	notice.Store(new(string))
	newer.Store(new(string))
	go checkUpdates(ctx, &notice, &newer)
	remote := newRemote(&newer)
	started := time.Now().UTC()
	load := &host.Sampler{}
	go load.Run(ctx)
	b := &box{setup: setup, compose: compose, sess: sess, load: load}
	go b.record(ctx, health)
	root.API = gatewayAPI(st, remote, store, b.status(started, store, remote), health, tunnels)
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
		// ponytail: no WriteTimeout, handlers wait on Jellyfin; header + idle limits are free
		srv := &http.Server{Addr: ":" + port, Handler: localpage.Guard(lanHost, localpage.Auth(token, page)),
			ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
		log.Fatal(srv.ListenAndServe())
	}()
	go forever(ctx, func(ctx context.Context) error {
		return onboarding.RunControl(
			ctx,
			api,
			st,
			lan,
			version,
			&lastBeat,
			func() string { return *newer.Load() },
			sess.Handle,
		)
	})
}

// newRemote is the web app's remote update for this binary; newer holds the latest release.
func newRemote(newer *atomic.Pointer[string]) *update.Remote {
	exe, _ := os.Executable()
	return &update.Remote{
		Version:   version,
		Supported: service.Supported(),
		Task:      func() bool { return service.Installed(exe) },
		Newer:     func() string { return *newer.Load() },
		Start:     startUpdater,
	}
}

// forever reruns fn until ctx ends. The API sockets are long-lived and
// mostly idle, and Railway's edge reaps idle sockets — so they WILL drop. A
// home gateway must survive that unattended, so reconnect with backoff instead
// of exiting. A session that stayed up a while resets the backoff; a
// fast-failing dial keeps backing off up to 30s. A refused protocol only
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
			return
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
