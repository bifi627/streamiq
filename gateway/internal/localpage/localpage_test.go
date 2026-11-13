package localpage

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"streamiq/gateway/internal/pairing"
)

// The page will approve browsers (PR B): a malicious website must not be able
// to drive it, neither by cross-site POST nor by DNS rebinding.
func TestGuard(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})
	h := Guard("nas.local", ok)
	cases := []struct {
		name, method, host, origin string
		want                       int
	}{
		{"LAN IP get", "GET", "192.168.1.20:8097", "", 200},
		{"localhost get", "GET", "localhost:8097", "", 200},
		{"configured host get", "GET", "nas.local:8097", "", 200},
		{"rebound attacker domain", "GET", "evil.example:8097", "", 403},
		{"same-origin post", "POST", "192.168.1.20:8097", "http://192.168.1.20:8097", 200},
		{"cross-origin post", "POST", "192.168.1.20:8097", "https://evil.example", 403},
		{"post without origin", "POST", "192.168.1.20:8097", "", 403},
	}
	for _, c := range cases {
		r := httptest.NewRequest(c.method, "/", nil)
		r.Host = c.host
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != c.want {
			t.Errorf("%s: status %d, want %d", c.name, w.Code, c.want)
		}
		if w.Header().Get("X-Frame-Options") != "DENY" {
			t.Errorf("%s: frameable", c.name)
		}
	}
}

// The page is open to the whole LAN: it names the file holding the Jellyfin
// admin password, never the password (TECH_DEBT "Local page shows Jellyfin
// admin password unauthenticated").
func TestPageShowsPasswordFileNotPassword(t *testing.T) {
	store, err := pairing.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var beat atomic.Int64
	var upd atomic.Pointer[string]
	upd.Store(new(string))
	jf := struct {
		Reachable, HasKey, NeedsLogin, Untested, LegacyKey, Managed bool
		Version, Tested, Err, User, Viewer, PasswordFile, HWAccel   string
	}{Reachable: true, HasKey: true, Managed: true, User: "streamiq", Viewer: "streamiq-viewer", PasswordFile: "/home/u/state/jellyfin.json"}
	h := Handler(Config{LastBeat: &beat, Update: &upd, Store: store, Jellyfin: func() any { return jf }})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "password in <code>/home/u/state/jellyfin.json</code>") ||
		!strings.Contains(w.Body.String(), "<b>managed</b> · hardware acceleration off") {
		t.Fatalf("status %d, body:\n%s", w.Code, w.Body)
	}
}

// `gateway status` reads /status.json over loopback; the LAN never gets it.
func TestStatusJSON(t *testing.T) {
	store, err := pairing.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var beat atomic.Int64
	beat.Store(time.Now().Add(-5 * time.Second).Unix())
	var upd atomic.Pointer[string]
	msg := "v1.0.0 → v1.1.0"
	upd.Store(&msg)
	jf := struct {
		Reachable, HasKey bool
		Version           string
	}{true, true, "10.11.2"}
	h := Handler(Config{Name: "nas", Version: "1.0.0", LastBeat: &beat, Update: &upd, Store: store, Jellyfin: func() any { return jf }})

	r := httptest.NewRequest("GET", "/status.json", nil)
	r.RemoteAddr = "192.168.1.30:5555"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("LAN request: status %d, want 403", w.Code)
	}

	srv := httptest.NewServer(h) // 127.0.0.1
	defer srv.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	var out strings.Builder
	if err := PrintStatus(context.Background(), &out, port, "http://192.168.1.20:8097/?t=x"); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"nas, version 1.0.0", "available: v1.0.0 → v1.1.0", "connected, last heartbeat",
		"reachable, version 10.11.2, token set", "from another device: http://192.168.1.20:8097/?t=x"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("missing %q in:\n%s", want, out.String())
		}
	}
	srv.Close()
	if err := PrintStatus(context.Background(), &out, port, ""); err == nil || !strings.Contains(err.Error(), "not running") {
		t.Fatalf("stopped gateway: err = %v", err)
	}
}
