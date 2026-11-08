package localpage

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

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
