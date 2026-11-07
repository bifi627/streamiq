// StreamIQ gateway. Wiring only — each feature lives in its own package under
// internal/ (vertical slices):
//
//	identity    persistent DTLS certificate + fingerprint (browsers pin it)
//	onboarding  enrollment token → credential, control socket + heartbeat
//	pairing     client-key auth, comparison code, allowlist + pending approvals
//	sessions    brokered browser sessions: auth channel, gated tunnel
//	localpage   the gateway's status page on the home LAN (approve / remove browsers)
//	jellyfin    gets the Jellyfin API key without manual steps; version check
//	tunnel      HTTP over data channels to Jellyfin (allowlist, key injection)
//	update      "newer release available" notice (never self-updates)
//
// Config (env, or gateway.env next to the binary / in the working dir; real
// env wins): STREAMIQ_API_URL (required), STREAMIQ_ENROLL_TOKEN, STREAMIQ_NAME, STREAMIQ_STATE_DIR,
// STREAMIQ_PAGE_PORT, STREAMIQ_LAN_URL, STREAMIQ_ORIGIN, STREAMIQ_JELLYFIN_API_KEY,
// STREAMIQ_JELLYFIN_USER, STREAMIQ_ICE_* (STREAMIQ_ICE_PORT: Docker, see sessions.NewAPI).
package main

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"streamiq/gateway/internal/identity"
	"streamiq/gateway/internal/jellyfin"
	"streamiq/gateway/internal/localpage"
	"streamiq/gateway/internal/onboarding"
	"streamiq/gateway/internal/pairing"
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
	if exe, err := os.Executable(); err == nil {
		loadEnvFile(filepath.Join(filepath.Dir(exe), "gateway.env")) // installed
	}
	loadEnvFile("gateway.env") // dev: gateway/gateway.env from scripts/setup-jellyfin.sh

	stateDir := env("STREAMIQ_STATE_DIR", "streamiq-state")
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
		Client: &http.Client{Transport: &http.Transport{DisableCompression: true}},
		URL:    env("STREAMIQ_ORIGIN", "http://localhost:8096"), // local Jellyfin
		User:   os.Getenv("STREAMIQ_JELLYFIN_USER"),
	}
	// Key: STREAMIQ_JELLYFIN_API_KEY wins; else the stored one, else the setup
	// loop mints one (fresh Jellyfin) or the local page asks for a login.
	setup := &jellyfin.Setup{Client: &http.Client{}, URL: jf.URL, StateDir: stateDir, OnKey: jf.SetKey}
	if k := os.Getenv("STREAMIQ_JELLYFIN_API_KEY"); k != "" {
		jf.SetKey(k, "")
		setup.Fixed = true
	}
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
		port := env("STREAMIQ_PAGE_PORT", "8097") // Jellyfin owns 8096
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
		sess := &sessions.Sessions{Cert: cert, Fp: fp, Store: store, Jellyfin: jf, API: webAPI}
		store.OnRemove = sess.Drop // removing a browser ends its open sessions
		var lastBeat atomic.Int64
		var notice atomic.Pointer[string]
		notice.Store(new(string))
		go checkUpdates(ctx, &notice)
		go func() {
			log.Printf("gateway: local page on %s", lan)
			page := localpage.Handler(localpage.Config{
				Name: st.Name, GatewayID: st.GatewayID, Fingerprint: fp, Version: version,
				LastBeat: &lastBeat, Update: &notice, Store: store,
				Jellyfin: func() any { return setup.View() }, Login: setup.Login,
			})
			log.Fatal(http.ListenAndServe(":"+port, localpage.Guard(lanHost, page)))
		}()
		go forever(ctx, func(ctx context.Context) error {
			return onboarding.RunControl(ctx, api, st, lan, version, &lastBeat, sess.Handle)
		})
	}

	<-ctx.Done()
}

// forever reruns fn until ctx ends. The API sockets are long-lived and
// mostly idle, and Railway's edge reaps idle sockets — so they WILL drop. A
// home gateway must survive that unattended, so reconnect with backoff instead
// of exiting. A session that stayed up a while resets the backoff; a
// fast-failing dial keeps backing off up to 30s.
func forever(ctx context.Context, fn func(context.Context) error) {
	backoff := time.Second
	for ctx.Err() == nil {
		start := time.Now()
		if err := fn(ctx); err != nil {
			log.Printf("gateway: %v", err)
		}
		if ctx.Err() != nil {
			return // Ctrl+C
		}
		if time.Since(start) > 30*time.Second {
			backoff = time.Second // the connection was healthy; treat this as a fresh drop
		}
		log.Printf("gateway: reconnecting in %s", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

// checkUpdates asks GitHub for the latest release at start, then daily, and
// publishes a notice (log + local page) when it's newer. Dev builds skip it.
func checkUpdates(ctx context.Context, notice *atomic.Pointer[string]) {
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
