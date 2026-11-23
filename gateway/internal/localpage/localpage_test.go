package localpage

import (
	"context"
	"errors"
	"fmt"
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
		Reachable, HasKey, NeedsLogin, Untested, Managed          bool
		Version, Tested, Err, User, Viewer, PasswordFile, HWAccel string
	}{Reachable: true, HasKey: true, Managed: true, User: "streamiq", Viewer: "streamiq-viewer", PasswordFile: "/home/u/state/jellyfin.json"}
	h := Handler(
		Config{
			Name:     func() string { return "" },
			LastBeat: &beat,
			Update:   &upd,
			Store:    store,
			Jellyfin: func() any { return jf },
		},
	)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "password in <code>/home/u/state/jellyfin.json</code>") ||
		!strings.Contains(w.Body.String(), "<b>managed</b> · hardware acceleration off") {
		t.Fatalf("status %d, body:\n%s", w.Code, w.Body)
	}
	// The jail state (#321): a line only with a compose Jellyfin.
	for offline, want := range map[string]string{"": "", "enforced": "Offline: enforced", "allowed": "Online lookups allowed"} {
		c := Config{
			Name:     func() string { return "" },
			LastBeat: &beat,
			Update:   &upd,
			Store:    store,
			Jellyfin: func() any { return jf },
			Offline:  func() string { return offline },
		}
		w = httptest.NewRecorder()
		Handler(c).ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
		body := w.Body.String()
		if want == "" && (strings.Contains(body, "Offline") || strings.Contains(body, "Online lookups")) ||
			!strings.Contains(body, want) {
			t.Errorf("offline %q, body:\n%s", offline, body)
		}
	}
	// Its admin refused (#240): the form says to sign in as it.
	jf.NeedsLogin = true
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if !strings.Contains(w.Body.String(), "Sign in as the gateway's admin <code>streamiq</code>") {
		t.Fatalf("refused admin, body:\n%s", w.Body)
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
	h := Handler(
		Config{
			Name:     func() string { return "nas" },
			Version:  "1.0.0",
			LastBeat: &beat,
			Update:   &upd,
			Store:    store,
			Jellyfin: func() any { return jf },
		},
	)

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
	if err := PrintStatus(
		context.Background(),
		&out,
		port,
		"",
	); err == nil ||
		!strings.Contains(err.Error(), "not running") {
		t.Fatalf("stopped gateway: err = %v", err)
	}
}

// The library list (#322): a button's Jellyfin error shows above the list,
// which stays readable; no list without a managed Jellyfin.
func TestLibrariesPage(t *testing.T) {
	store, err := pairing.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var beat atomic.Int64
	var upd atomic.Pointer[string]
	upd.Store(new(string))
	type lib struct {
		ID, Name string
		Offline  bool
		Extras   string
	}
	var offlined, extras string
	c := Config{Name: func() string { return "" }, LastBeat: &beat, Update: &upd, Store: store,
		Jellyfin: func() any {
			return struct {
				Reachable, HasKey, NeedsLogin, Untested, Managed          bool
				Version, Tested, Err, User, Viewer, PasswordFile, HWAccel string
			}{Reachable: true, HasKey: true, Managed: true}
		},
		Libraries: func(context.Context) (any, error) {
			return []lib{{"a", "Home videos", false, "Custom"}, {"b", "Films", true, "On"}}, nil
		},
		MakeOffline: func(_ context.Context, id string) error { offlined = id; return errors.New("HTTP 500") },
		SetExtras:   func(_ context.Context, id string, on bool) error { extras = fmt.Sprint(id, " ", on); return nil },
	}
	do := func(c Config, method, path, form string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(form))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		Handler(c).ServeHTTP(w, r)
		return w
	}
	if w := do(c, "GET", "/", ""); !strings.Contains(w.Body.String(), `href="/libraries"`) {
		t.Fatalf("no link:\n%s", w.Body)
	}
	body := do(c, "GET", "/libraries", "").Body.String()
	for _, want := range []string{"Home videos", "Online (set in Jellyfin)", "Make offline", "Custom (set in Jellyfin)", "Films", "<b>Offline</b>"} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q:\n%s", want, body)
		}
	}
	if strings.Count(body, "Make offline") != 1 {
		t.Errorf("Make offline on an offline library:\n%s", body)
	}
	if w := do(c, "POST", "/libraries/extras", "id=a&on=1"); w.Code != http.StatusSeeOther || extras != "a true" {
		t.Fatalf("extras: %d %q", w.Code, extras)
	}
	if w := do(
		c,
		"POST",
		"/libraries/offline",
		"id=a",
	); offlined != "a" ||
		!strings.Contains(w.Body.String(), "Jellyfin: HTTP 500") ||
		!strings.Contains(w.Body.String(), "Home videos") {
		t.Fatalf("error: %d\n%s", w.Code, w.Body)
	}
	c.Libraries = nil
	if w := do(
		c,
		"GET",
		"/libraries",
		"",
	); w.Code != http.StatusNotFound ||
		strings.Contains(do(c, "GET", "/", "").Body.String(), "/libraries") {
		t.Fatalf("no Libraries: %d", w.Code)
	}
}
