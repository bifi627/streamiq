// The StreamIQ API (Go): wiring only.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
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
	"streamiq/api/internal/tunnels"
	"streamiq/api/internal/turn"
)

func main() {
	ctx := context.Background()
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
	household.Routes(mux, a, d, ips)
	members.Routes(mux, a, d)
	invites.Routes(mux, a, d, ips)
	onboarding.Routes(mux, a, d, ips, onboarding.Install{
		PublicURL: os.Getenv("STREAMIQ_PUBLIC_URL"),
		Dev:       os.Getenv("STREAMIQ_ENV") == "development",
	})
	web := os.Getenv("STREAMIQ_WEB_DIR") // the built web app: the image sets it; in dev Vite serves it
	srv := &http.Server{
		Addr:              env("STREAMIQ_API_ADDR", ":"+env("PORT", "5028")), // PORT: what container hosts inject
		Handler:           front.Handler(mux, strings.Split(env("CORS_ORIGINS", "http://localhost:5173"), ","), web),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("api: listening on %s", srv.Addr)
	log.Fatal(srv.ListenAndServe())
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
