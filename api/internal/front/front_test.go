package front

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/coder/websocket"
)

// A stand-in for the .NET API: answers any HTTP request with its path and its own CORS
// header, and echoes one WebSocket message.
func legacyAPI(t *testing.T) *url.URL {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") == "websocket" {
			c, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer func() { _ = c.CloseNow() }()
			typ, b, err := c.Read(r.Context())
			if err == nil {
				_ = c.Write(r.Context(), typ, append([]byte("legacy:"), b...))
			}
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "*")
		_, _ = io.WriteString(w, "legacy:"+r.Method+" "+r.URL.Path)
	}))
	t.Cleanup(ts.Close)
	u, _ := url.Parse(ts.URL)
	return u
}

func serve(t *testing.T) string {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/me", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "go") })
	ts := httptest.NewServer(Handler(mux, []string{"http://app.test", " http://tv.test"}, legacyAPI(t)))
	t.Cleanup(ts.Close)
	return ts.URL
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

func TestRoutesGoServesAndTheRestIsProxied(t *testing.T) {
	base := serve(t)
	for path, want := range map[string]string{
		"/api/me":       "go",
		"/healthz":      `{"status":"ok"}` + "\n",
		"/api/gateways": "legacy:GET /api/gateways",
		"/somewhere":    "legacy:GET /somewhere",
	} {
		if _, got := do(t, http.MethodGet, base+path); got != want {
			t.Errorf("GET %s: %q, want %q", path, got, want)
		}
	}
	if _, got := do(t, http.MethodPost, base+"/api/me"); got != "legacy:POST /api/me" {
		t.Errorf("POST /api/me: %q", got)
	}
}

func TestWebSocketsAreProxied(t *testing.T) {
	ws := "ws" + serve(t)[len("http"):]
	c, _, err := websocket.Dial(t.Context(), ws+"/api/broker/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.CloseNow() }()
	if werr := c.Write(t.Context(), websocket.MessageText, []byte("hi")); werr != nil {
		t.Fatal(werr)
	}
	_, b, err := c.Read(context.WithoutCancel(t.Context()))
	if err != nil || string(b) != "legacy:hi" {
		t.Fatalf("got %q, %v", b, err)
	}
}

// What ASP.NET Core's CORS policy answered (curl against the .NET API before the port).
func TestCORSAnswersAsDotNetDid(t *testing.T) {
	base := serve(t)
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
			"preflight for a proxied route",
			http.MethodOptions,
			"/api/gateways",
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
			"a proxied one: the legacy API's own CORS header is dropped",
			http.MethodGet,
			"/api/gateways",
			[]string{"Origin", "http://app.test"},
			http.StatusOK,
			map[string]string{
				"Access-Control-Allow-Origin":   "http://app.test",
				"Access-Control-Expose-Headers": "X-StreamIQ-Not-Member",
			},
		},
		{"a request from another origin", http.MethodGet, "/api/gateways", []string{"Origin", "http://evil.test"},
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
