// The StreamIQ API (Go): wiring only.
package main

import (
	"context"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"streamiq/api/internal/auth"
	"streamiq/api/internal/db"
	"streamiq/api/internal/front"
	"streamiq/api/internal/me"
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
