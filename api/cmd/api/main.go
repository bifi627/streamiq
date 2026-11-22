// The StreamIQ API (Go): wiring only.
package main

import (
	"context"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/broker"
	"streamiq/api/internal/db"
	"streamiq/api/internal/front"
	"streamiq/api/internal/gateways"
	"streamiq/api/internal/iplimit"
	"streamiq/api/internal/me"
	"streamiq/api/internal/onboarding"
	"streamiq/api/internal/tunnels"
	"streamiq/api/internal/turn"
)

func main() {
	ctx := context.Background()
	// DATABASE_URL is the tables' owner: it migrates and sets the app role's password.
	d, err := db.Open(
		ctx,
		env("DATABASE_URL", "postgres://streamiq:dev@localhost:5432/streamiq"),
		need("STREAMIQ_APP_DB_PASSWORD"),
	)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	verifier, err := auth.NewVerifier(ctx)
	if err != nil {
		log.Fatal(err)
	}
	var legacy *url.URL
	if v := os.Getenv("STREAMIQ_LEGACY_API_URL"); v != "" {
		if legacy, err = url.Parse(v); err != nil {
			log.Fatal(err)
		}
	}
	a := auth.New(verifier, d)
	mux := http.NewServeMux()
	me.Routes(mux, a)
	perMinute, err := strconv.Atoi(env("STREAMIQ_SIGNALING_PER_MINUTE", "120"))
	if err != nil {
		log.Fatalf("STREAMIQ_SIGNALING_PER_MINUTE: %v", err)
	}
	// One per-IP budget for the broker sockets, enrollment and enrollment tokens.
	ips := iplimit.New(perMinute, os.Getenv("STREAMIQ_CLIENT_IP_HEADER"))
	b := broker.New(d, a, turn.FromEnv(), ips)
	b.Routes(mux)
	gateways.Routes(mux, a, d, b)
	tunnels.Routes(mux, a, d)
	onboarding.Routes(mux, a, d, ips, onboarding.Install{
		PublicURL: os.Getenv("STREAMIQ_PUBLIC_URL"),
		Dev:       os.Getenv("STREAMIQ_ENV") == "development",
	})
	srv := &http.Server{
		Addr:              env("STREAMIQ_API_ADDR", ":"+env("PORT", "5028")), // PORT: what container hosts inject
		Handler:           front.Handler(mux, strings.Split(env("CORS_ORIGINS", "http://localhost:5173"), ","), legacy),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("api: listening on %s", srv.Addr)
	log.Fatal(srv.ListenAndServe())
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func need(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("%s is not set", key)
	}
	return v
}
