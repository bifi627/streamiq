// StreamIQ gateway. Wiring only — each feature lives in its own package under
// internal/ (vertical slices):
//
//	identity    persistent DTLS certificate + fingerprint (browsers pin it)
//	onboarding  enrollment token → credential, control socket + heartbeat
//	pairing     client-key auth, comparison code, allowlist + pending approvals
//	sessions    brokered browser sessions: auth channel, gated tunnel
//	localpage   the gateway's status page on the home LAN (approve / remove browsers)
//	jellyfin    non-admin Jellyfin viewer token without manual steps; transcoding settings; version check;
//	            `gateway jellyfin up|upgrade` (Docker compose)
//	tunnel      HTTP over data channels to Jellyfin (allowlist, token injection)
//	update      "newer release available" notice; `gateway update` swaps the binary
//	service     Windows logon task (`gateway service install|uninstall`)
//
// Commands: gateway [run] | service install|uninstall | update | status | jellyfin up|upgrade | reset-identity.
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
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync/atomic"
	"time"

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

	cmd := "run"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	// ponytail: one usage text for every command; per-command help when a command grows flags.
	help := slices.ContainsFunc(os.Args[1:], func(a string) bool {
		return a == "-h" || a == "--help" || a == "-help" || a == "help"
	})
	switch {
	case help:
		fmt.Println(usage)
	case cmd == "run":
		run(ctx)
	case cmd == "service" && len(os.Args) == 3 && os.Args[2] == "install":
		err = serviceInstall(ctx, exe)
	case cmd == "service" && len(os.Args) == 3 && os.Args[2] == "uninstall":
		err = service.Uninstall(exe)
		if err == nil {
			fmt.Println("Removed the logon task and stopped the gateway. state/ and gateway.env are kept.")
		}
	case cmd == "update":
		err = selfUpdate(ctx, exe)
	case cmd == "jellyfin" && len(os.Args) == 3 && os.Args[2] == "up":
		err = jellyfinUp(ctx, filepath.Join(filepath.Dir(exe), jellyfin.ComposeFile))
	case cmd == "jellyfin" && len(os.Args) == 3 && os.Args[2] == "upgrade":
		var changed bool
		changed, err = jellyfin.Upgrade(ctx, filepath.Join(filepath.Dir(exe), jellyfin.ComposeFile))
		if err == nil && changed {
			fmt.Println("Jellyfin now runs", jellyfin.Image)
		} else if err == nil {
			fmt.Println("Already on", jellyfin.Image)
		}
	case cmd == "reset-identity":
		err = resetIdentity()
	case cmd == "status":
		link, _ := os.ReadFile(filepath.Join(stateDir(), "page-link"))
		err = localpage.PrintStatus(ctx, os.Stdout, pagePort(), strings.TrimSpace(string(link)))
	default:
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "gateway:", err)
		os.Exit(1)
	}
}

const usage = `usage: gateway [command] [-h]
  run                        run the gateway (default)
  service install|uninstall  start it at logon in its own window (Windows)
  update                     install the latest release (Windows)
  status                     show the running gateway's status
  jellyfin up                start Jellyfin in Docker (downloads jellyfin-compose.yml once)
  jellyfin upgrade           pin jellyfin-compose.yml to the tested Jellyfin and restart it
  reset-identity             new certificate + empty paired-browser list: every browser pairs
                             again (after a leak; docs/install.md). Refuses while the gateway runs.

Config: gateway.env next to the binary (see docs/install.md).`

func stateDir() string { return env("STREAMIQ_STATE_DIR", "streamiq-state") }
func pagePort() string { return env("STREAMIQ_PAGE_PORT", "8097") } // Jellyfin owns 8096

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

// resetIdentity replaces the DTLS cert and clears the allowlist. A running
// gateway holds both in memory (and would rewrite allowlist.json), so refuse
// while its local page answers.
func resetIdentity() error {
	if c, err := net.DialTimeout("tcp", "127.0.0.1:"+pagePort(), time.Second); err == nil {
		c.Close()
		return fmt.Errorf("the gateway is running (port %s answers): stop it first (Windows: gateway service uninstall, or close its window)", pagePort())
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

// selfUpdate installs the latest release over exe (user-invoked only) and
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
	task := service.Installed()
	if task {
		service.Stop(exe)
	}
	err = update.Swap(exe, exe+".new")
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
	return nil
}

// run is the gateway daemon.
func run(ctx context.Context) {
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
		URL: env("STREAMIQ_ORIGIN", "http://localhost:8096"), // local Jellyfin
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
		var lastBeat atomic.Int64
		var notice, newer atomic.Pointer[string]
		notice.Store(new(string))
		newer.Store(new(string))
		go checkUpdates(ctx, &notice, &newer)
		started := time.Now().UTC()
		jf.Status = func(user string) any { // gateway API GET /streamiq/status (docs/protocol.md)
			v := setup.View()
			return map[string]any{
				"transcoding": v.Transcoding(),
				"os":          runtime.GOOS, "arch": runtime.GOARCH, "startedAt": started,
				"jellyfin": map[string]any{
					"reachable": v.Reachable, "version": v.Version, "untested": v.Untested, "token": v.Token(),
				},
				// Counts only: no client names (#65).
				"pairedClients": len(store.Paired()), "activeSessions": sess.Active(),
				"viewer": setup.ViewerState(user), // this session's own (#242)
			}
		}
		token, err := localpage.Token(stateDir, lan)
		if err != nil {
			log.Fatalf("gateway: page token: %v", err)
		}
		go func() {
			log.Printf("gateway: local page on %s (login link in %s)", lan, filepath.Join(stateDir, "page-link"))
			page := localpage.Handler(localpage.Config{
				Name: st.Name, GatewayID: st.GatewayID, Fingerprint: fp, Version: version,
				LastBeat: &lastBeat, Update: &notice, Store: store,
				Jellyfin: func() any { return setup.View() }, Login: setup.Login,
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
