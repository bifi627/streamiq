// The StreamIQ API (Go): wiring only.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/broker"
	"streamiq/api/internal/db"
	"streamiq/api/internal/front"
	"streamiq/api/internal/gateways"
	"streamiq/api/internal/household"
	"streamiq/api/internal/invites"
	"streamiq/api/internal/iplimit"
	"streamiq/api/internal/me"
	"streamiq/api/internal/members"
	"streamiq/api/internal/onboarding"
	"streamiq/api/internal/relayusage"
	"streamiq/api/internal/tunnels"
	"streamiq/api/internal/turn"
)

// shutdownTimeout bounds a stop: the sockets' cleanup, then the open requests. Railway
// kills the process RAILWAY_DEPLOYMENT_DRAINING_SECONDS after SIGTERM, which must be longer.
const shutdownTimeout = 8 * time.Second

func main() {
	ctx, stopped := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stopped()
	url, err := databaseURL()
	if err != nil {
		log.Fatal(err)
	}
	// DATABASE_URL is the tables' owner: it migrates and sets the app role's password.
	d, err := db.Open(ctx, url, os.Getenv("STREAMIQ_APP_DB_PASSWORD"))
	var parse *pgconn.ParseConfigError
	if errors.As(err, &parse) {
		// pgx redacts the password from a URL it can't parse only on a best-effort basis.
		log.Fatal("database: DATABASE_URL does not parse (the URL itself, or its ssl* settings)")
	}
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	verifier, err := auth.NewVerifier(ctx)
	if err != nil {
		log.Fatal(err)
	}
	a := auth.New(verifier, d)
	mux := http.NewServeMux()
	me.Routes(mux, a)
	perMinute, err := strconv.Atoi(env("STREAMIQ_SIGNALING_PER_MINUTE", "120"))
	if err != nil {
		log.Fatalf("STREAMIQ_SIGNALING_PER_MINUTE: %v", err)
	}
	// One per-IP budget for the broker sockets, enrollment, enrollment tokens, new
	// households and new invites.
	ips := iplimit.New(perMinute, os.Getenv("STREAMIQ_CLIENT_IP_HEADER"))
	b := broker.New(d, a, turn.FromEnv(), ips)
	b.Routes(mux)
	gateways.Routes(mux, a, d, b)
	tunnels.Routes(mux, a, d)
	relayusage.Routes(mux, a, d)
	if job := relayusage.FromEnv(d); job != nil {
		go job.Run(ctx)
	}
	household.Routes(mux, a, d, ips)
	members.Routes(mux, a, d)
	invites.Routes(mux, a, d, ips)
	onboarding.Routes(mux, a, d, ips, onboarding.Install{
		PublicURL: os.Getenv("STREAMIQ_PUBLIC_URL"),
		Dev:       os.Getenv("STREAMIQ_ENV") == "development",
	})
	web := os.Getenv("STREAMIQ_WEB_DIR") // the built web app: the image sets it; in dev Vite serves it
	h, err := front.Handler(mux, strings.Split(env("CORS_ORIGINS", "http://localhost:5173"), ","), web)
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{
		Addr:              env("STREAMIQ_API_ADDR", ":"+env("PORT", "5028")), // PORT: what container hosts inject
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second,
	}
	serve(ctx, srv, b)
}

// serve runs srv until ctx is done, then closes the broker's sockets through their normal
// cleanup (tunnel ends, TURN revokes) and stops srv, within shutdownTimeout.
func serve(ctx context.Context, srv *http.Server, b *broker.Broker) {
	go func() {
		log.Printf("api: listening on %s", srv.Addr)
		if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	<-ctx.Done()
	log.Print("api: stopping")
	stop, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := b.Shutdown(stop); err != nil {
		log.Printf("api: sockets not all closed: %v", err)
	}
	if err := srv.Shutdown(stop); err != nil {
		log.Printf("api: requests not all done: %v", err)
	}
}

var errNoDatabaseURL = errors.New("DATABASE_URL is not set (required unless STREAMIQ_ENV=development)")

// databaseURL falls back to the compose Postgres in development only, so a production
// start without DATABASE_URL fails here instead of dialling localhost.
func databaseURL() (string, error) {
	if url := os.Getenv("DATABASE_URL"); url != "" {
		return url, nil
	}
	if os.Getenv("STREAMIQ_ENV") != "development" {
		return "", errNoDatabaseURL
	}
	return "postgres://streamiq:dev@localhost:5432/streamiq", nil
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
