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

type fakeUser struct {
	id, pw string
	admin  bool
	policy map[string]any
}

// fake speaks just enough Jellyfin: the wizard, users with policies and
// passwords, sign-in tokens (one per user, like one DeviceId), and API keys.
type fake struct {
	mu        sync.Mutex
	wizard    bool
	users     map[string]*fakeUser
	tokens    map[string]string // token → user name
	keys      map[string]bool   // pre-#50 admin API keys
	n         int
	loggedOut []string       // users whose session was logged out
	enc       map[string]any // /System/Configuration/encoding
	encPosts  int
}

func newFake(t *testing.T, wizardDone bool) (*fake, *httptest.Server) {
	f := &fake{wizard: wizardDone, users: map[string]*fakeUser{}, tokens: map[string]string{}, keys: map[string]bool{},
		enc: map[string]any{"HardwareAccelerationType": "none", "EnableThrottling": false, "EncoderPreset": "auto", "QsvDevice": "keep me"}}
	if wizardDone {
		f.users["streamiq"] = &fakeUser{id: "id-admin", pw: "pw", admin: true}
	}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fake) revoke(name string) {
	for t, u := range f.tokens {
		if u == name {
			delete(f.tokens, t)
		}
	}
}

func (f *fake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	tok := ""
	if m := regexp.MustCompile(`Token="([^"]*)"`).FindStringSubmatch(r.Header.Get("Authorization")); m != nil {
		tok = m[1]
	}
	caller := f.users[f.tokens[tok]]
	admin := (caller != nil && caller.admin) || f.keys[tok]
	path := r.URL.Path
	var id string
	if m := regexp.MustCompile(`^/Users/(id-[^/]+)/(Password|Policy)$`).FindStringSubmatch(path); m != nil {
		id, path = m[1], "/Users/{id}/"+m[2]
	}
	if strings.HasPrefix(path, "/Auth/Keys/") {
		id, path = strings.TrimPrefix(path, "/Auth/Keys/"), "/Auth/Keys/{key}"
	}
	byID := func() *fakeUser {
		for _, u := range f.users {
			if u.id == id {
				return u
			}
		}
		return nil
	}
	deny := func(code int) { w.WriteHeader(code) }
	switch r.Method + " " + path {
	case "GET /System/Info/Public":
		json.NewEncoder(w).Encode(map[string]any{"Version": "12.4.0", "StartupWizardCompleted": f.wizard})
	case "POST /Startup/Configuration", "GET /Startup/User", "POST /Startup/RemoteAccess":
		if f.wizard {
			deny(401)
		}
	case "POST /Startup/User":
		var u struct{ Name, Password string }
		json.NewDecoder(r.Body).Decode(&u)
		f.users[u.Name] = &fakeUser{id: "id-admin", pw: u.Password, admin: true}
	case "POST /Startup/Complete":
		f.wizard = true
	case "POST /Users/AuthenticateByName":
		var b struct{ Username, Pw string }
		json.NewDecoder(r.Body).Decode(&b)
		u := f.users[b.Username]
		if u == nil || u.pw != b.Pw || u.pw == "" {
			deny(401)
			return
		}
		f.revoke(b.Username) // same DeviceId: the new token replaces the old
		f.n++
		t := fmt.Sprintf("tok-%d", f.n)
		f.tokens[t] = b.Username
		json.NewEncoder(w).Encode(map[string]any{"AccessToken": t, "User": map[string]string{"Id": u.id}})
	case "GET /Users/Me":
		if caller == nil {
			deny(401)
		}
	case "GET /Users":
		if !admin {
			deny(401)
			return
		}
		var out []map[string]any
		for n, u := range f.users {
			out = append(out, map[string]any{"Name": n, "Id": u.id, "Policy": u.policy})
		}
		json.NewEncoder(w).Encode(out)
	case "POST /Users/New":
		var b struct{ Name, Password string }
		json.NewDecoder(r.Body).Decode(&b)
		if !admin || f.users[b.Name] != nil {
			deny(400)
			return
		}
		u := &fakeUser{id: "id-" + b.Name, pw: b.Password, policy: map[string]any{
			"IsHidden": true, "EnablePublicSharing": true, "EnableSharedDeviceControl": true,
			"AuthenticationProviderId": "Default", "PasswordResetProviderId": "Default",
		}}
		f.users[b.Name] = u
		json.NewEncoder(w).Encode(map[string]any{"Name": b.Name, "Id": u.id, "Policy": u.policy})
	case "POST /Users/{id}/Password":
		var b struct{ NewPw string }
		json.NewDecoder(r.Body).Decode(&b)
		u := byID()
		if !admin || u == nil {
			deny(403)
			return
		}
		u.pw = b.NewPw
		for n, x := range f.users {
			if x == u {
				f.revoke(n)
			}
		}
	case "POST /Users/{id}/Policy":
		var p map[string]any
		json.NewDecoder(r.Body).Decode(&p)
		u := byID()
		if !admin || u == nil || p["AuthenticationProviderId"] == nil { // Jellyfin requires the whole object
			deny(400)
			return
		}
		u.policy, u.admin = p, p["IsAdministrator"] == true
	case "DELETE /Auth/Keys/{key}":
		if !admin || !f.keys[id] {
			deny(404)
			return
		}
		delete(f.keys, id)
	case "GET /System/Configuration/encoding":
		if !admin {
			deny(401)
			return
		}
		json.NewEncoder(w).Encode(f.enc)
	case "POST /System/Configuration/encoding":
		var e map[string]any
		json.NewDecoder(r.Body).Decode(&e)
		if !admin || e["QsvDevice"] == nil { // the whole object goes back
			deny(400)
			return
		}
		f.enc = e
		f.encPosts++
	case "POST /Sessions/Logout":
		f.loggedOut = append(f.loggedOut, f.tokens[tok])
		delete(f.tokens, tok)
	default:
		deny(404)
	}
}

func newSetup(t *testing.T, url string, got *[2]string) *Setup {
	return &Setup{Client: http.DefaultClient, URL: url, StateDir: t.TempDir(),
		OnKey: func(k, u string) { got[0], got[1] = k, u }}
}

// connected checks the gateway ends up on a live viewer token: hidden,
// non-admin, policy round-tripped whole, and the admin session logged out.
func connected(t *testing.T, f *fake, s *Setup, got [2]string) Creds {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	c := s.creds
	v := f.users[ViewerName]
	if v == nil || f.tokens[got[0]] != ViewerName || got[1] != v.id || c.Token != got[0] || c.ViewerID != v.id {
		t.Fatalf("not on the viewer token: onKey %v, creds %+v", got, c)
	}
	p := v.policy
	if v.admin || p["IsHidden"] != true || p["EnableSharedDeviceControl"] != false || p["EnablePublicSharing"] != false ||
		p["PasswordResetProviderId"] != "Default" {
		t.Fatalf("viewer policy %v", p)
	}
	for _, u := range f.tokens {
		if u != ViewerName {
			t.Fatalf("a %s session lingers (logged out: %v)", u, f.loggedOut)
		}
	}
	return c
}

func TestBootstrapFreshJellyfin(t *testing.T) {
	f, srv := newFake(t, false)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	s.poll(context.Background())
	v := s.View()
	connected(t, f, s, got)
	if !v.HasKey || v.NeedsLogin || v.PasswordFile == "" || v.Err != "" || v.User != "streamiq" || v.Viewer != ViewerName {
		t.Fatalf("after bootstrap: view %+v", v)
	}
	// Passwords stay in the 0600 file; the view (rendered on the LAN page) never carries them.
	var c Creds
	b, _ := os.ReadFile(v.PasswordFile)
	if json.Unmarshal(b, &c) != nil || c.Password == "" || c.ViewerPassword == "" ||
		strings.Contains(fmt.Sprintf("%+v", v), c.Password) || strings.Contains(fmt.Sprintf("%+v", v), c.ViewerPassword) {
		t.Fatalf("password file %s / view %+v", b, v)
	}
	// Persisted: a restart loads the token instead of re-running the wizard.
	tok := got[0]
	got = [2]string{}
	s2 := newSetup(t, srv.URL, &got)
	s2.StateDir = s.StateDir
	if err := s2.Load(); err != nil || got[0] != tok || s2.View().PasswordFile != v.PasswordFile {
		t.Fatalf("reload: %v, onKey %v", err, got)
	}
	if fi, _ := os.Stat(s.path()); fi.Mode().Perm()&0o077 != 0 && os.PathSeparator == '/' {
		t.Fatalf("jellyfin.json mode %v, want 0600", fi.Mode())
	}
}

func TestLoginExistingJellyfin(t *testing.T) {
	f, srv := newFake(t, true)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	s.poll(context.Background())
	if v := s.View(); !v.NeedsLogin || v.HasKey {
		t.Fatalf("set-up Jellyfin, no token: want NeedsLogin, got %+v", v)
	}
	if err := s.Login(context.Background(), "streamiq", "wrong"); err == nil {
		t.Fatal("wrong password accepted")
	}
	if err := s.Login(context.Background(), "streamiq", "pw"); err != nil {
		t.Fatal(err)
	}
	connected(t, f, s, got)
	b, _ := os.ReadFile(s.path())
	if strings.Contains(string(b), `"pw"`) || s.View().NeedsLogin || s.View().PasswordFile != "" {
		t.Fatalf("stored the admin password or still needs login: %s", b)
	}
}

// A viewer from an earlier run (or a half-finished one) is adopted: same user,
// new password, policy enforced again.
func TestExistingViewerAdopted(t *testing.T) {
	f, srv := newFake(t, true)
	f.users[ViewerName] = &fakeUser{id: "id-old-viewer", pw: "lost", admin: true,
		policy: map[string]any{"IsAdministrator": true, "AuthenticationProviderId": "Default", "PasswordResetProviderId": "Default"}}
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	if err := s.Login(context.Background(), "streamiq", "pw"); err != nil {
		t.Fatal(err)
	}
	if c := connected(t, f, s, got); c.ViewerID != "id-old-viewer" || f.users[ViewerName].pw == "lost" {
		t.Fatalf("not adopted: %+v", c)
	}
}

// A revoked token repairs itself with the stored viewer password; if that
// password is refused too, the page asks for an admin login again.
func TestRevokedTokenRepairs(t *testing.T) {
	f, srv := newFake(t, true)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	if err := s.Login(context.Background(), "streamiq", "pw"); err != nil {
		t.Fatal(err)
	}
	old := got[0]
	f.mu.Lock()
	f.revoke(ViewerName) // e.g. signed out in Dashboard → Devices
	f.mu.Unlock()
	s.poll(context.Background())
	if connected(t, f, s, got); got[0] == old {
		t.Fatal("kept the revoked token")
	}
	f.mu.Lock()
	f.users[ViewerName].pw = "changed by someone"
	f.revoke(ViewerName)
	f.mu.Unlock()
	s.poll(context.Background())
	if v := s.View(); got[0] != "" || !v.NeedsLogin || v.HasKey {
		t.Fatalf("viewer sign-in refused: onKey %v, view %+v", got, v)
	}
}

// A pre-#50 install keeps streaming on its admin API key (pinned to its user)
// until the next page login, which moves it to the viewer and deletes the key.
func TestLegacyKeyMigrates(t *testing.T) {
	f, srv := newFake(t, true)
	f.keys["legacy-key"] = true
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	os.WriteFile(s.path(), []byte(`{"apiKey":"legacy-key","user":"streamiq","password":"pw"}`), 0o600)
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	s.poll(context.Background())
	if v := s.View(); got != [2]string{"legacy-key", "id-admin"} || !v.LegacyKey || !v.HasKey || !v.NeedsLogin {
		t.Fatalf("legacy key: onKey %v, view %+v", got, v)
	}
	if err := s.Login(context.Background(), "streamiq", "pw"); err != nil {
		t.Fatal(err)
	}
	c := connected(t, f, s, got)
	if f.keys["legacy-key"] || c.APIKey != "" || s.View().LegacyKey || c.Password != "pw" {
		t.Fatalf("after migration: keys %v, creds %+v", f.keys, c)
	}
}

// The binary's Tested and Image pins and both compose image pins must agree, or
// the status page warns about the version we ship (or upgrade writes another).
func TestPinsMatchTested(t *testing.T) {
	re := regexp.MustCompile(`image: jellyfin/jellyfin:(\S+)`)
	for _, f := range []string{"../../../docker-compose.yml", "../../install/jellyfin-compose.yml"} {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		m := re.FindSubmatch(b)
		if m == nil || "jellyfin/jellyfin:"+string(m[1]) != Image {
			t.Errorf("%s: Jellyfin image %q, want %s", f, m, Image)
		}
	}
	if !strings.HasPrefix(Image, "jellyfin/jellyfin:"+Tested+".") {
		t.Errorf("Image %s is not Jellyfin %s", Image, Tested)
	}
}

// encoding returns the fake's encoding config and POST count.
func (f *fake) encoding() (map[string]any, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.enc, f.encPosts
}

// A Jellyfin the gateway set up gets every config step right away, as the
// stored admin (logged out again), with unknown fields kept.
func TestBootstrapSeedsConfig(t *testing.T) {
	f, srv := newFake(t, false)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	s.poll(context.Background())
	connected(t, f, s, got)
	enc, posts := f.encoding()
	if posts != 1 || enc["EnableThrottling"] != true || enc["EnableSegmentDeletion"] != true ||
		enc["HardwareAccelerationType"] != "none" || enc["QsvDevice"] != "keep me" {
		t.Fatalf("after bootstrap: %d posts, %v", posts, enc)
	}
	if v := s.View(); !v.Managed || v.Err != "" || s.creds.ConfigSteps != len(configSteps) {
		t.Fatalf("view %+v, creds %+v", v, s.creds)
	}
	s.poll(context.Background())
	if _, n := f.encoding(); n != 1 {
		t.Fatalf("nothing pending, still posted (%d)", n)
	}
}

// After an update only the new steps run: a setting the user changed since
// the first step stays changed.
func TestUpdateAppliesOnlyNewSteps(t *testing.T) {
	f, srv := newFake(t, false)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	s.poll(context.Background())
	f.mu.Lock()
	f.enc["EnableThrottling"] = false // the user turned it off in the Dashboard
	f.mu.Unlock()
	old := configSteps
	t.Cleanup(func() { configSteps = old })
	configSteps = append(old[:len(old):len(old)], func(enc map[string]any) { enc["H264Crf"] = 20 })
	s.poll(context.Background())
	if enc, n := f.encoding(); n != 2 || enc["EnableThrottling"] != false || enc["H264Crf"] != float64(20) {
		t.Fatalf("%d posts, %v", n, enc)
	}
	if s.creds.ConfigSteps != len(configSteps) {
		t.Fatalf("creds %+v", s.creds)
	}
}

// STREAMIQ_JELLYFIN_HWACCEL is followed both ways; turning NVENC off keeps
// the rest (it does nothing without an accelerator).
func TestHWAccelFollowsEnv(t *testing.T) {
	f, srv := newFake(t, false)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	s.HWAccel = "nvenc"
	s.poll(context.Background())
	enc, _ := f.encoding()
	if enc["HardwareAccelerationType"] != "nvenc" || enc["EncoderPreset"] != "fast" || enc["EnableHardwareEncoding"] != true ||
		enc["AllowHevcEncoding"] != false || len(enc["HardwareDecodingCodecs"].([]any)) != 7 || s.View().HWAccel != "nvenc" ||
		s.View().Transcoding() != "nvenc" {
		t.Fatalf("nvenc: %v", enc)
	}
	s.HWAccel = "" // e.g. no GPU in the container after all
	s.poll(context.Background())
	enc, n := f.encoding()
	if n != 2 || enc["HardwareAccelerationType"] != "none" || enc["EncoderPreset"] != "fast" || s.View().HWAccel != "" ||
		s.View().Transcoding() != "none" {
		t.Fatalf("off: %d posts, %v", n, enc)
	}
}

// A Jellyfin the user brought (admin login, no stored password) is never
// configured, whatever the env says.
func TestUserJellyfinUntouched(t *testing.T) {
	f, srv := newFake(t, true)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	s.HWAccel = "nvenc"
	if err := s.Login(context.Background(), "streamiq", "pw"); err != nil {
		t.Fatal(err)
	}
	s.poll(context.Background())
	if _, n := f.encoding(); n != 0 || s.View().Managed || s.View().Err != "" || s.View().Transcoding() != "unmanaged" {
		t.Fatalf("configured a user's Jellyfin: %d posts, view %+v", n, s.View())
	}
}

// The user changed the bootstrapped admin's password: the page says so,
// playback keeps its token, and the next poll retries.
func TestConfigAdminRefused(t *testing.T) {
	f, srv := newFake(t, false)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	s.poll(context.Background())
	f.mu.Lock()
	pw := f.users["streamiq"].pw
	f.users["streamiq"].pw = "changed"
	f.mu.Unlock()
	s.HWAccel = "nvenc"
	s.poll(context.Background())
	if v := s.View(); v.Err == "" || !v.HasKey || got[0] == "" || v.HWAccel != "" {
		t.Fatalf("refused: view %+v", v)
	}
	f.mu.Lock()
	f.users["streamiq"].pw = pw
	f.mu.Unlock()
	s.poll(context.Background())
	if enc, _ := f.encoding(); enc["HardwareAccelerationType"] != "nvenc" || s.View().Err != "" {
		t.Fatalf("retry: %v, view %+v", enc, s.View())
	}
}
