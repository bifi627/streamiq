// Package front is what sits around the slices' routes: /healthz, CORS, and, while
// the port runs, the .NET API behind every request no slice serves.
package front

import (
	"encoding/json"
	"net/http"
	"net/http/httputil"
	"net/url"
	"slices"
	"strings"

	"streamiq/api/internal/auth"
)

// allowedHeaders are the request headers the SPA may send cross-origin.
var allowedHeaders = "Authorization,Content-Type," + auth.HouseholdHeader

// Handler serves mux behind CORS for origins. With legacy set, every request mux has no
// route for, WebSocket upgrades included, goes to that API instead.
// TODO(#732): legacy goes with the .NET API.
func Handler(mux *http.ServeMux, origins []string, legacy *url.URL) http.Handler {
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})
	if legacy != nil {
		proxy := httputil.NewSingleHostReverseProxy(legacy)
		proxy.ModifyResponse = func(r *http.Response) error { // CORS is answered here, never twice
			for k := range r.Header {
				if strings.HasPrefix(k, "Access-Control-") {
					r.Header.Del(k)
				}
			}
			return nil
		}
		mux.Handle("/", proxy)
	}
	for i := range origins {
		origins[i] = strings.TrimSpace(origins[i])
	}
	return cors(origins, mux)
}

// cors answers as ASP.NET Core's policy did (WithOrigins + WithHeaders + AllowAnyMethod
// + WithExposedHeaders): a preflight is a 204 whatever the outcome, with the allow
// headers only for a listed origin; the browser compares the headers it asked for.
// WebSockets ignore CORS (the broker authenticates in-band).
func cors(origins []string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		listed := origin != "" && slices.Contains(origins, origin)
		method := r.Header.Get("Access-Control-Request-Method")
		if listed {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		if r.Method == http.MethodOptions && origin != "" && method != "" {
			if listed {
				w.Header().Set("Access-Control-Allow-Headers", allowedHeaders)
				w.Header().Set("Access-Control-Allow-Methods", method)
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if listed {
			w.Header().Set("Access-Control-Expose-Headers", auth.NotMemberHeader)
		}
		next.ServeHTTP(w, r)
	})
}
