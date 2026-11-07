package jellyfin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
)

// fakeJellyfin speaks just enough of the wizard + key API: one admin
// "streamiq" once the wizard sets a password, and a key list.
func fakeJellyfin(t *testing.T, wizardDone bool, adminPw string) *httptest.Server {
	var mu sync.Mutex
	var keys []string
	loggedOut := false
	t.Cleanup(func() {
		if len(keys) > 0 && !loggedOut {
			t.Error("password session not logged out")
		}
	})
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		authed := strings.Contains(r.Header.Get("Authorization"), `Token="session"`)
		switch r.Method + " " + r.URL.Path {
		case "GET /System/Info/Public":
			json.NewEncoder(w).Encode(map[string]any{"Version": "12.4.0", "StartupWizardCompleted": wizardDone})
		case "POST /Startup/Configuration", "GET /Startup/User", "POST /Startup/RemoteAccess", "POST /Startup/Complete":
			if wizardDone {
				w.WriteHeader(http.StatusUnauthorized)
			}
		case "POST /Startup/User":
			var u struct{ Name, Password string }
			json.NewDecoder(r.Body).Decode(&u)
			adminPw = u.Password
		case "POST /Users/AuthenticateByName":
			var u struct{ Username, Pw string }
			json.NewDecoder(r.Body).Decode(&u)
			if u.Username != "streamiq" || u.Pw != adminPw || adminPw == "" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.Write([]byte(`{"AccessToken":"session"}`))
		case "POST /Auth/Keys":
			if !authed || r.URL.Query().Get("app") != "streamiq-gateway" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			keys = append(keys, "key-"+string(rune('a'+len(keys))))
		case "GET /Auth/Keys":
			items := []map[string]string{{"AppName": "other", "AccessToken": "nope"}}
			for _, k := range keys {
				items = append(items, map[string]string{"AppName": "streamiq-gateway", "AccessToken": k})
			}
			json.NewEncoder(w).Encode(map[string]any{"Items": items})
		case "POST /Sessions/Logout":
			loggedOut = authed
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func newSetup(t *testing.T, url string, got *[2]string) *Setup {
	return &Setup{Client: http.DefaultClient, URL: url, StateDir: t.TempDir(),
		OnKey: func(k, u string) { got[0], got[1] = k, u }}
}

func TestBootstrapFreshJellyfin(t *testing.T) {
	srv := fakeJellyfin(t, false, "")
	defer srv.Close()
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	s.poll(context.Background())
	v := s.View()
	if got != [2]string{"key-a", "streamiq"} || !v.HasKey || v.PasswordFile == "" || v.Err != "" {
		t.Fatalf("after bootstrap: onKey %v, view %+v", got, v)
	}
	// The password stays in the 0600 file; the view (rendered on the LAN page) never carries it.
	var c Creds
	b, _ := os.ReadFile(v.PasswordFile)
	if json.Unmarshal(b, &c) != nil || c.Password == "" || strings.Contains(fmt.Sprintf("%+v", v), c.Password) {
		t.Fatalf("password file %s / view %+v", b, v)
	}
	// Persisted: a restart loads the key instead of re-running the wizard.
	got = [2]string{}
	s2 := newSetup(t, srv.URL, &got)
	s2.StateDir = s.StateDir
	if err := s2.Load(); err != nil || got[0] != "key-a" || s2.View().PasswordFile != v.PasswordFile {
		t.Fatalf("reload: %v, onKey %v", err, got)
	}
	if fi, _ := os.Stat(s.path()); fi.Mode().Perm()&0o077 != 0 && os.PathSeparator == '/' {
		t.Fatalf("jellyfin.json mode %v, want 0600", fi.Mode())
	}
}

func TestLoginExistingJellyfin(t *testing.T) {
	srv := fakeJellyfin(t, true, "pw")
	defer srv.Close()
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	s.poll(context.Background())
	if v := s.View(); !v.NeedsLogin || v.HasKey {
		t.Fatalf("set-up Jellyfin, no key: want NeedsLogin, got %+v", v)
	}
	if err := s.Login(context.Background(), "streamiq", "wrong"); err == nil {
		t.Fatal("wrong password accepted")
	}
	if err := s.Login(context.Background(), "streamiq", "pw"); err != nil || got[0] != "key-a" {
		t.Fatalf("login: %v, onKey %v", err, got)
	}
	b, _ := os.ReadFile(s.path())
	if strings.Contains(string(b), `"pw"`) || s.View().NeedsLogin || s.View().PasswordFile != "" {
		t.Fatalf("stored the password or still needs login: %s", b)
	}
}

func TestFixedKeyNeverBootstraps(t *testing.T) {
	srv := fakeJellyfin(t, false, "")
	defer srv.Close()
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	s.Fixed = true
	s.poll(context.Background())
	if got[0] != "" || s.View().NeedsLogin || !s.View().HasKey {
		t.Fatalf("STREAMIQ_JELLYFIN_API_KEY set: onKey %v, view %+v", got, s.View())
	}
}

// The binary's Tested pin and both compose image pins must agree, or the
// status page warns about the version we ship.
func TestPinsMatchTested(t *testing.T) {
	re := regexp.MustCompile(`image: jellyfin/jellyfin:(\S+)`)
	for _, f := range []string{"../../../docker-compose.yml", "../../install/jellyfin-compose.yml"} {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		m := re.FindSubmatch(b)
		if m == nil || !strings.HasPrefix(string(m[1]), Tested+".") {
			t.Errorf("%s: Jellyfin image %q, want %s.*", f, m, Tested)
		}
	}
}
