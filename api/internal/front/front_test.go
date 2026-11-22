package front

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

const index = "<!doctype html>spa"

// serve runs Handler with one Go route; webDir "" = no web app (dev, tests), "app" = a
// built one with index.html and one asset.
func serve(t *testing.T, webDir string) string {
	t.Helper()
	if webDir == "app" {
		webDir = t.TempDir()
		must(t, os.WriteFile(filepath.Join(webDir, "index.html"), []byte(index), 0o600))
		must(t, os.MkdirAll(filepath.Join(webDir, "assets"), 0o700))
		must(t, os.WriteFile(filepath.Join(webDir, "assets", "app.js"), []byte("js"), 0o600))
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/me", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "go") })
	ts := httptest.NewServer(Handler(mux, []string{"http://app.test", " http://tv.test"}, webDir))
	t.Cleanup(ts.Close)
	return ts.URL
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func do(t *testing.T, method, url string, headers ...string) (*http.Response, string) {
	t.Helper()
	rq, _ := http.NewRequestWithContext(t.Context(), method, url, nil)
	for i := 0; i+1 < len(headers); i += 2 {
		rq.Header.Set(headers[i], headers[i+1])
	}
	rs, err := http.DefaultClient.Do(rq)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rs.Body.Close() }()
	b, _ := io.ReadAll(rs.Body)
	return rs, string(b)
}

// SpaFallbackTests: client routes get index.html, files are served, unknown /api paths
// and missing files stay a 404, /healthz stays JSON.
func TestTheWebAppAndItsClientRoutes(t *testing.T) {
	base := serve(t, "app")
	for path, want := range map[string]struct {
		status int
		body   string
	}{
		"/":                       {http.StatusOK, index},
		"/g/some-gateway":         {http.StatusOK, index},
		"/g/some-gateway/i/item":  {http.StatusOK, index},
		"/assets":                 {http.StatusOK, index},
		"/assets/app.js":          {http.StatusOK, "js"},
		"/assets/missing.js":      {http.StatusNotFound, ""},
		"/api":                    {http.StatusNotFound, ""},
		"/api/nope":               {http.StatusNotFound, ""},
		"/api/members":            {http.StatusNotFound, ""},
		"/api/me":                 {http.StatusOK, "go"},
		"/healthz":                {http.StatusOK, `{"status":"ok"}` + "\n"},
		"/../../etc/passwd":       {http.StatusOK, index},
		"/assets/../../secret.js": {http.StatusNotFound, ""},
	} {
		rs, got := do(t, http.MethodGet, base+path)
		if rs.StatusCode != want.status || (want.body != "" && got != want.body) {
			t.Errorf("GET %s: %d %q, want %d %q", path, rs.StatusCode, got, want.status, want.body)
		}
	}
}

// Without a web app (dev, tests) every path no slice serves is a 404: there is no proxy.
func TestWithoutAWebAppTheRestIs404(t *testing.T) {
	base := serve(t, "")
	for _, path := range []string{"/", "/g/x", "/api/gateways", "/index.html"} {
		if rs, _ := do(t, http.MethodGet, base+path); rs.StatusCode != http.StatusNotFound {
			t.Errorf("GET %s: %d, want 404", path, rs.StatusCode)
		}
	}
}

// HealthzTests: every response carries the security headers.
func TestEveryResponseCarriesTheSecurityHeaders(t *testing.T) {
	for _, webDir := range []string{"", "app"} {
		base := serve(t, webDir)
		for _, path := range []string{"/healthz", "/api/me", "/api/nope", "/some/client/route", "/assets/app.js", "/x.js"} {
			for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodOptions} {
				rs, _ := do(t, method, base+path, "Origin", "http://app.test", "Access-Control-Request-Method", "GET")
				for k, v := range map[string]string{
					"X-Content-Type-Options":  "nosniff",
					"Content-Security-Policy": "frame-ancestors 'none'",
					"Referrer-Policy":         "strict-origin-when-cross-origin",
				} {
					if got := rs.Header.Values(k); len(got) != 1 || got[0] != v {
						t.Errorf("web %q, %s %s: %s %q, want %q", webDir, method, path, k, got, v)
					}
				}
			}
		}
	}
}

// What ASP.NET Core's CORS policy answered (curl against the .NET API before the port);
// a listed origin's preflight is approved, another gets no allow header, and
// the not-a-member header is exposed.
func TestCORSAnswersAsThePortedPolicy(t *testing.T) {
	base := serve(t, "app")
	const allowHeaders = "Authorization,Content-Type,X-StreamIQ-Household"
	cases := []struct {
		name, method, path string
		headers            []string
		status             int
		want               map[string]string // "" = header absent
	}{
		{
			"preflight from a listed origin",
			http.MethodOptions,
			"/api/me",
			[]string{
				"Origin",
				"http://tv.test",
				"Access-Control-Request-Method",
				"DELETE",
				"Access-Control-Request-Headers",
				"authorization,x-evil",
			},
			http.StatusNoContent,
			map[string]string{
				"Access-Control-Allow-Origin": "http://tv.test", "Access-Control-Allow-Methods": "DELETE",
				"Access-Control-Allow-Headers": allowHeaders, "Access-Control-Expose-Headers": "",
			},
		},
		{
			"preflight for an unknown route",
			http.MethodOptions,
			"/api/nope",
			[]string{"Origin", "http://app.test", "Access-Control-Request-Method", "GET"},
			http.StatusNoContent,
			map[string]string{
				"Access-Control-Allow-Origin":  "http://app.test",
				"Access-Control-Allow-Headers": allowHeaders,
			},
		},
		{
			"preflight from another origin",
			http.MethodOptions,
			"/api/me",
			[]string{"Origin", "http://evil.test", "Access-Control-Request-Method", "GET"},
			http.StatusNoContent,
			map[string]string{
				"Access-Control-Allow-Origin":  "",
				"Access-Control-Allow-Methods": "",
				"Access-Control-Allow-Headers": "",
			},
		},
		{
			"a request from a listed origin",
			http.MethodGet,
			"/api/me",
			[]string{"Origin", "http://app.test"},
			http.StatusOK,
			map[string]string{
				"Access-Control-Allow-Origin":   "http://app.test",
				"Access-Control-Expose-Headers": "X-StreamIQ-Not-Member",
			},
		},
		{
			"a 404 from a listed origin",
			http.MethodGet,
			"/api/nope",
			[]string{"Origin", "http://app.test"},
			http.StatusNotFound,
			map[string]string{
				"Access-Control-Allow-Origin":   "http://app.test",
				"Access-Control-Expose-Headers": "X-StreamIQ-Not-Member",
			},
		},
		{"a request from another origin", http.MethodGet, "/api/me", []string{"Origin", "http://evil.test"},
			http.StatusOK, map[string]string{"Access-Control-Allow-Origin": "", "Access-Control-Expose-Headers": ""}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rs, _ := do(t, c.method, base+c.path, c.headers...)
			if rs.StatusCode != c.status {
				t.Errorf("status %d, want %d", rs.StatusCode, c.status)
			}
			for k, v := range c.want {
				if got := rs.Header.Get(k); got != v {
					t.Errorf("%s: %q, want %q", k, got, v)
				}
			}
		})
	}
}
