// The spike's Go API (#720): wiring only.
package main

import (
	"context"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"streamiq/backend/internal/server"
	"streamiq/backend/migrations"
)

func main() {
	ctx := context.Background()
	// DATABASE_URL is the tables' owner and only migrates. The API itself connects as
	// streamiq_app (STREAMIQ_APP_DATABASE_URL), which row-level security applies to.
	if err := migrations.Up(ctx, need("DATABASE_URL")); err != nil {
		log.Fatalf("migrate: %v", err)
	}
	db, err := server.OpenDB(ctx, need("STREAMIQ_APP_DATABASE_URL"))
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	verifier, err := server.NewVerifier(ctx)
	if err != nil {
		log.Fatal(err)
	}
	cfg := server.Config{
		CORSOrigins: strings.Split(env("CORS_ORIGINS", "http://localhost:5173"), ","),
		Turn:        server.TurnFromEnv(os.Getenv),
	}
	if legacy := os.Getenv("STREAMIQ_LEGACY_API_URL"); legacy != "" {
		if cfg.LegacyAPI, err = url.Parse(legacy); err != nil {
			log.Fatal(err)
		}
	}
	srv := &http.Server{
		Addr:              ":" + env("PORT", "5028"),
		Handler:           server.New(db, verifier, cfg).Handler(),
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
