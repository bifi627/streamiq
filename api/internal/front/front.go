// Package front is what sits around the slices' routes: /healthz, CORS, the security
// headers and the built web app.
package front

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"

	"streamiq/api/internal/auth"
)

// allowedHeaders are the request headers the SPA may send cross-origin.
var allowedHeaders = "Authorization,Content-Type," + auth.HouseholdHeader

// Handler serves mux behind CORS for origins, every response with the security headers.
// With webDir set, mux also serves the built web app from it, and every response carries
// the build's Content-Security-Policy (csp.txt, from frontend/src/csp.ts); without (dev,
// tests), a path no slice serves is a 404 and the policy only forbids framing.
func Handler(mux *http.ServeMux, origins []string, webDir string) (http.Handler, error) {
	policy := "frame-ancestors 'none'"
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})
	if webDir != "" {
		b, err := os.ReadFile(filepath.Join(webDir, "csp.txt"))
		if err != nil {
			return nil, fmt.Errorf("the web app's policy: %w", err)
		}
		policy = strings.TrimSpace(string(b))
		mux.Handle("GET /", web(webDir))
	}
	for i := range origins {
		origins[i] = strings.TrimSpace(origins[i])
	}
	return secure(policy, cors(origins, mux)), nil
}

// web serves dir's files. A path without a file extension that names no file is a
// client route: index.html. Unknown /api paths stay a 404, never the web app.
func web(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case p == "/api" || strings.HasPrefix(p, "/api/"):
			http.NotFound(w, r)
		case path.Ext(p) == "" && !isFile(http.Dir(dir), p):
			http.ServeFile(w, r, filepath.Join(dir, "index.html"))
		default:
			files.ServeHTTP(w, r)
		}
	})
}

func isFile(fs http.FileSystem, name string) bool {
	f, err := fs.Open(name)
	if err != nil {
		return false
	}
	defer func() { _ = f.Close() }()
	st, err := f.Stat()
	return err == nil && !st.IsDir()
}

// secure sets the security headers on every response, the web app's files included.
func secure(policy string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Security-Policy", policy)
		// Origin only, never the path. Not no-referrer: the Firebase web API key is
		// restricted by HTTP referrer, and sign-in fails without one.
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		next.ServeHTTP(w, r)
	})
}

// cors allows the listed origins, the request headers the app sends, any method, and
// exposes the not-a-member header: a preflight is a 204 whatever the outcome, with the allow
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
