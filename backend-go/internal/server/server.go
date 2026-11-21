// Package server is the spike's Go API: auth, the tenant-isolated REST endpoints it
// needs, and the signaling broker.
package server

import (
	"encoding/json"
	"net/http"
	"net/http/httputil"
	"net/url"
	"slices"
	"strings"
	"time"

	fbauth "firebase.google.com/go/v4/auth"
	"github.com/jackc/pgx/v5"

	"streamiq/backend/api"
)

// Config is what main reads from the environment.
type Config struct {
	CORSOrigins []string
	// LegacyAPI, when set, serves every /api path this server doesn't (the .NET API on
	// the same database). Spike only: a finished port has none.
	LegacyAPI *url.URL
	Turn      TurnConfig
	// AuthTimeout is how long an unauthenticated browser socket may stay silent.
	AuthTimeout time.Duration
}

type Server struct {
	db       *DB
	verifier *fbauth.Client
	cfg      Config
	broker   *broker
}

func New(db *DB, verifier *fbauth.Client, cfg Config) *Server {
	if cfg.AuthTimeout == 0 {
		cfg.AuthTimeout = 10 * time.Second
	}
	return &Server{db: db, verifier: verifier, cfg: cfg, broker: newBroker()}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/me", s.authed(true, s.me))
	mux.HandleFunc("GET /api/gateways", s.authed(false, s.listGateways))
	mux.HandleFunc("PATCH /api/tunnels/{id}", s.authed(false, s.tunnelThroughput))
	mux.HandleFunc("/api/broker/ws", s.browserSocket)
	mux.HandleFunc("/api/gateways/ws", s.gatewaySocket)
	if s.cfg.LegacyAPI != nil {
		proxy := httputil.NewSingleHostReverseProxy(s.cfg.LegacyAPI)
		proxy.ModifyResponse = func(r *http.Response) error { // this server answers CORS, not both
			for k := range r.Header {
				if strings.HasPrefix(k, "Access-Control-") {
					r.Header.Del(k)
				}
			}
			return nil
		}
		mux.Handle("/api/", proxy)
	}
	return s.cors(mux)
}

// cors lists only the SPA's origins. WebSockets ignore it (the broker authenticates in-band).
func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); o != "" && slices.Contains(s.cfg.CORSOrigins, o) {
			w.Header().Set("Access-Control-Allow-Origin", o)
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Expose-Headers", notMemberHeader)
			if r.Method == http.MethodOptions {
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, "+householdHeader)
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) me(w http.ResponseWriter, _ *http.Request, c caller) {
	me := api.Me{UserID: c.User, Memberships: c.Households}
	if me.Memberships == nil {
		me.Memberships = []api.Household{}
	}
	if c.Tenant != "" {
		me.TenantID = &c.Tenant
	}
	writeJSON(w, http.StatusOK, me)
}

// 3 missed 30 s gateway heartbeats = offline.
const onlineWindow = 90 * time.Second

// No WHERE on the tenant: row-level security scopes the query.
func (s *Server) listGateways(w http.ResponseWriter, r *http.Request, c caller) {
	list := []api.Gateway{}
	err := s.db.InTenant(r.Context(), c.Tenant, func(tx pgx.Tx) error {
		rows, _ := tx.Query(r.Context(), `
			SELECT "Id", "Name", "LastSeenAt", "LanUrl", "Version", "Update", "Telemetry",
			       coalesce("LastSeenAt" > $1, false), coalesce("Protocol" < $2, false)
			FROM gateways WHERE "CredentialHash" IS NOT NULL ORDER BY "CreatedAt"`,
			time.Now().Add(-onlineWindow), minGatewayProtocol)
		var err error
		list, err = pgx.AppendRows(list, rows, func(r pgx.CollectableRow) (g api.Gateway, err error) {
			return g, r.Scan(&g.ID, &g.Name, &g.LastSeenAt, &g.LanURL, &g.Version, &g.Update, &g.Telemetry, &g.Online, &g.UpgradeRequired)
		})
		return err
	})
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// The browser's one part of tunnel telemetry: its measured throughput, on its own
// tunnel only. Another household's row is invisible (RLS), another user's is filtered: both 404.
func (s *Server) tunnelThroughput(w http.ResponseWriter, r *http.Request, c caller) {
	var body api.TunnelThroughput
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body) != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if body.ThroughputKbps != nil && *body.ThroughputKbps <= 0 {
		body.ThroughputKbps = nil
	}
	found := false
	err := s.db.InTenant(r.Context(), c.Tenant, func(tx pgx.Tx) error {
		tag, err := tx.Exec(r.Context(), `UPDATE tunnels SET "ThroughputKbps" = $1 WHERE "Id"::text = $2 AND "UserId" = $3`,
			body.ThroughputKbps, strings.ToLower(r.PathValue("id")), c.User)
		found = tag.RowsAffected() > 0
		return err
	})
	switch {
	case err != nil:
		w.WriteHeader(http.StatusInternalServerError)
	case !found:
		w.WriteHeader(http.StatusNotFound)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}
