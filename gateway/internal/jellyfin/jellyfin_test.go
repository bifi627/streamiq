package jellyfin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
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
	news      int // POST /Users/New
}

func newFake(t *testing.T, wizardDone bool) (*fake, *httptest.Server) {
	f := &fake{wizard: wizardDone, users: map[string]*fakeUser{}, tokens: map[string]string{}, keys: map[string]bool{},
		enc: map[string]any{"HardwareAccelerationType": "none", "EnableThrottling": false, "EncoderPreset": "auto", "QsvDevice": "keep me"}}
	if wizardDone {
		f.users["me"] = &fakeUser{id: "id-me", pw: "pw", admin: true} // the user's own admin
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
		f.news++
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
	if err := s.Login(context.Background(), "me", "wrong"); err == nil {
		t.Fatal("wrong password accepted")
	}
	if err := s.Login(context.Background(), "me", "pw"); err != nil {
		t.Fatal(err)
	}
	connected(t, f, s, got)
	b, _ := os.ReadFile(s.path())
	if strings.Contains(string(b), `"pw"`) || s.View().NeedsLogin || s.View().PasswordFile != "" {
		t.Fatalf("stored the admin password or still needs login: %s", b)
	}
	// The gateway's own hidden admin, so it can create viewers later (#195).
	own := func() (Creds, *fakeUser) {
		s.mu.Lock()
		f.mu.Lock()
		defer s.mu.Unlock()
		defer f.mu.Unlock()
		return s.creds, f.users[byoAdmin]
	}
	c, a := own()
	if a == nil || !a.admin || a.policy["IsHidden"] != true || c.User != byoAdmin || c.Password != a.pw || !c.BYO {
		t.Fatalf("gateway admin: creds %+v, user %+v", c, a)
	}
	if s.View().Managed {
		t.Fatal("BYO Jellyfin shown as managed")
	}
	// Reconnecting adopts it with a new password; signing in as it is refused.
	if err := s.Login(context.Background(), "me", "pw"); err != nil {
		t.Fatal(err)
	}
	if c2, a2 := own(); c2.Password == c.Password || c2.Password != a2.pw || a2.id != a.id {
		t.Fatalf("reconnect: creds %+v, user %+v", c2, a2)
	}
	if _, a := own(); s.Login(context.Background(), byoAdmin, a.pw) == nil {
		t.Fatal("signed in as the gateway's own admin")
	}
}

// An install from before #195 on a BYO Jellyfin has a viewer token but no admin
// of its own: the page asks to reconnect once, playback keeps working meanwhile.
func TestBYOWithoutOwnAdminAsksToReconnect(t *testing.T) {
	_, srv := newFake(t, true)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	if err := s.Login(context.Background(), "me", "pw"); err != nil {
		t.Fatal(err)
	}
	c := s.creds
	c.User, c.Password, c.BYO = "", "", false // as written before #195
	b, _ := json.Marshal(c)
	if err := os.WriteFile(s.path(), b, 0o600); err != nil {
		t.Fatal(err)
	}
	got = [2]string{}
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	s.poll(context.Background())
	if v := s.View(); !v.NeedsLogin || got[0] == "" {
		t.Fatalf("view %+v, onKey %v", v, got)
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
	if err := s.Login(context.Background(), "me", "pw"); err != nil {
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
	if err := s.Login(context.Background(), "me", "pw"); err != nil {
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
	f.users["streamiq"] = &fakeUser{id: "id-admin", pw: "pw", admin: true} // the gateway set Jellyfin up
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
	if err := s.Login(context.Background(), "me", "pw"); err != nil {
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

// The human changed the bootstrapped admin's password (#240): a page login as
// another admin doesn't store its password nor end the refusal; one as
// streamiq stores the new password, and members' viewers and the transcoding
// settings work again without a restart.
func TestManagedAdminLoginStoresPassword(t *testing.T) {
	f, srv := newFake(t, false)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	ctx := context.Background()
	s.poll(ctx)
	s.poll(ctx) // sees the wizard done
	old := s.creds.Password
	f.mu.Lock()
	f.users["streamiq"].pw = "new"
	f.users["me"] = &fakeUser{id: "id-me", pw: "pw", admin: true}
	f.mu.Unlock()
	s.HWAccel = "nvenc"
	s.EnsureViewer(ctx, alice)
	if v := s.View(); !v.NeedsLogin || !strings.Contains(v.Err, "Sign in as streamiq") {
		t.Fatalf("refused: view %+v", v)
	}
	if err := s.Login(ctx, "me", "pw"); err != nil {
		t.Fatal(err)
	}
	stored := func() string {
		var c Creds
		b, _ := os.ReadFile(s.path())
		json.Unmarshal(b, &c)
		return c.Password
	}
	if s.creds.Password != old || stored() != old || !s.View().NeedsLogin {
		t.Fatalf("another admin's login: stored %q, view %+v", stored(), s.View())
	}
	s.EnsureViewer(ctx, alice)
	if tok, _ := s.ViewerFor(alice); tok != "" {
		t.Fatal("tried the refused admin again")
	}
	if err := s.Login(ctx, "streamiq", "new"); err != nil {
		t.Fatal(err)
	}
	if stored() != "new" || s.View().NeedsLogin {
		t.Fatalf("streamiq's login: stored %q, view %+v", stored(), s.View())
	}
	s.EnsureViewer(ctx, alice)
	mine(t, f, s, alice)
	s.poll(ctx)
	if enc, _ := f.encoding(); enc["HardwareAccelerationType"] != "nvenc" || s.View().Err != "" {
		t.Fatalf("settings: %v, view %+v", enc, s.View())
	}
}

// An edit of jellyfin.json takes effect on the next poll, without a restart; a
// malformed one shows on the page and keeps the creds in memory (#240).
func TestCredsFileReloaded(t *testing.T) {
	f, srv := newFake(t, false)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	ctx := context.Background()
	s.poll(ctx)
	s.poll(ctx) // sees the wizard done
	f.mu.Lock()
	f.users["streamiq"].pw = "new"
	f.mu.Unlock()
	s.EnsureViewer(ctx, alice)
	if !s.View().NeedsLogin {
		t.Fatalf("not refused: view %+v", s.View())
	}
	at := time.Now()
	write := func(b []byte) {
		t.Helper()
		at = at.Add(time.Second) // a coarse mtime still moves
		if os.WriteFile(s.path(), b, 0o600) != nil || os.Chtimes(s.path(), at, at) != nil {
			t.Fatal("write jellyfin.json")
		}
	}
	b, _ := os.ReadFile(s.path())
	edited := strings.Replace(string(b), s.creds.Password, "new", 1)
	write([]byte(edited))
	s.poll(ctx)
	if v := s.View(); v.NeedsLogin || v.Err != "" || s.creds.Password != "new" {
		t.Fatalf("edit ignored: view %+v", v)
	}
	s.EnsureViewer(ctx, alice)
	tok, _ := mine(t, f, s, alice)
	write([]byte("{"))
	s.poll(ctx)
	if v := s.View(); !strings.Contains(v.Err, "kept the credentials") || !v.HasKey || s.creds.Password != "new" {
		t.Fatalf("malformed: view %+v", v)
	}
	if t2, _ := s.ViewerFor(alice); t2 != tok {
		t.Fatal("malformed file dropped a viewer")
	}
	b, _ = json.Marshal(s.creds)
	write(b)
	s.poll(ctx)
	if v := s.View(); v.Err != "" {
		t.Fatalf("fixed: view %+v", v)
	}
}

const (
	alice = "11111111-1111-1111-1111-111111111111"
	bob   = "22222222-2222-2222-2222-222222222222"
)

// mine checks user has their own live viewer: hidden, non-admin, named after them.
func mine(t *testing.T, f *fake, s *Setup, user string) (tok, id string) {
	t.Helper()
	tok, id = s.ViewerFor(user)
	f.mu.Lock()
	defer f.mu.Unlock()
	name := "streamiq-" + user
	v := f.users[name]
	if v == nil || v.admin || v.policy["IsHidden"] != true || v.policy["EnableSharedDeviceControl"] != false ||
		f.tokens[tok] != name || id != v.id {
		t.Fatalf("%s: token %q id %q, Jellyfin user %+v", user, tok, id, v)
	}
	return tok, id
}

// Each StreamIQ user gets their own viewer on their first session (#195), on a
// Jellyfin the user brought and on one the gateway set up; later sessions and
// a restart reuse it.
func TestViewerPerUser(t *testing.T) {
	for _, byo := range []bool{true, false} {
		f, srv := newFake(t, byo)
		var got [2]string
		s := newSetup(t, srv.URL, &got)
		if byo {
			if err := s.Login(context.Background(), "me", "pw"); err != nil {
				t.Fatal(err)
			}
		} else {
			s.poll(context.Background())
		}
		ctx := context.Background()
		s.EnsureViewer(ctx, alice)
		s.EnsureViewer(ctx, bob)
		a, aid := mine(t, f, s, alice)
		b, bid := mine(t, f, s, bob)
		if aid == bid || a == b || aid == s.creds.ViewerID {
			t.Fatalf("byo=%v: shared viewer: %s %s", byo, aid, bid)
		}
		news := f.news
		s.EnsureViewer(ctx, alice)
		if a2, _ := mine(t, f, s, alice); a2 != a || f.news != news {
			t.Fatalf("byo=%v: second session made a new viewer or token", byo)
		}
		f.mu.Lock()
		for _, u := range f.tokens {
			if f.users[u].admin {
				t.Fatalf("byo=%v: a %s session lingers", byo, u)
			}
		}
		f.mu.Unlock()
		s2 := newSetup(t, srv.URL, &got)
		s2.StateDir = s.StateDir
		if err := s2.Load(); err != nil {
			t.Fatal(err)
		}
		if a2, _ := s2.ViewerFor(alice); a2 != a {
			t.Fatalf("byo=%v: restart lost alice's viewer", byo)
		}
		s.EnsureViewer(ctx, "../x")
		if tok, _ := s.ViewerFor("../x"); tok != "" || f.users["streamiq-../x"] != nil {
			t.Fatal("made a viewer for a bad user id")
		}
		if tok, _ := s.ViewerFor(strings.ToUpper(alice)); tok != a {
			t.Fatal("user id case matters")
		}
	}
}

// Two sessions of the same new user at the same moment make one viewer.
func TestViewerOnce(t *testing.T) {
	f, srv := newFake(t, true)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	if err := s.Login(context.Background(), "me", "pw"); err != nil {
		t.Fatal(err)
	}
	news := f.news
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() { s.EnsureViewer(context.Background(), alice) })
	}
	wg.Wait()
	mine(t, f, s, alice) // its stored token still works: no second adoption reset it
	if f.news != news+1 {
		t.Fatalf("created %d viewers", f.news-news)
	}
}

// If making a user's viewer fails, they play as the shared viewer and the page
// says why. A refused admin isn't tried again (Jellyfin locks users out after
// failed sign-ins) until a page login; other failures retry on the next session.
func TestViewerFallback(t *testing.T) {
	f, srv := newFake(t, true)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	ctx := context.Background()
	if err := s.Login(ctx, "me", "pw"); err != nil {
		t.Fatal(err)
	}
	s.poll(ctx)
	f.mu.Lock()
	pw := f.users[byoAdmin].pw
	f.users[byoAdmin].pw = "changed by someone"
	f.mu.Unlock()
	s.EnsureViewer(ctx, alice)
	if tok, _ := s.ViewerFor(alice); tok != "" || !strings.Contains(s.View().Err, "reconnect Jellyfin") || !s.View().NeedsLogin {
		t.Fatalf("token %q, view %+v", tok, s.View())
	}
	f.mu.Lock()
	f.users[byoAdmin].pw = pw
	f.mu.Unlock()
	s.EnsureViewer(ctx, alice)
	if tok, _ := s.ViewerFor(alice); tok != "" {
		t.Fatal("tried the refused admin again before a login")
	}
	if err := s.Login(ctx, "me", "pw"); err != nil {
		t.Fatal(err)
	}
	s.EnsureViewer(ctx, alice)
	mine(t, f, s, alice)
	if v := s.View(); v.Err != "" || v.NeedsLogin {
		t.Fatalf("after a login: view %+v", v)
	}
}

// A user's revoked viewer token repairs itself; if Jellyfin refuses its
// password, the viewer is dropped and made again on their next session.
func TestViewerTokenRepairs(t *testing.T) {
	f, srv := newFake(t, true)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	if err := s.Login(context.Background(), "me", "pw"); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	s.EnsureViewer(ctx, alice)
	old, _ := mine(t, f, s, alice)
	f.mu.Lock()
	f.revoke("streamiq-" + alice)
	f.mu.Unlock()
	s.poll(ctx)
	if tok, _ := mine(t, f, s, alice); tok == old {
		t.Fatal("kept the revoked token")
	}
	f.mu.Lock()
	f.users["streamiq-"+alice].pw = "changed by someone"
	f.revoke("streamiq-" + alice)
	f.mu.Unlock()
	s.poll(ctx)
	if tok, _ := s.ViewerFor(alice); tok != "" {
		t.Fatal("kept a refused viewer")
	}
	s.EnsureViewer(ctx, alice)
	old, _ = mine(t, f, s, alice)
	// Still repaired once the shared viewer's token is gone for good.
	f.mu.Lock()
	f.users[ViewerName].pw = "changed by someone"
	f.revoke(ViewerName)
	f.mu.Unlock()
	s.poll(ctx) // drops the shared token
	f.mu.Lock()
	f.revoke("streamiq-" + alice)
	f.mu.Unlock()
	s.poll(ctx)
	if tok, _ := mine(t, f, s, alice); tok == old || s.View().HasKey {
		t.Fatalf("view %+v", s.View())
	}
}

// The transcoding state is logged once per start, with where to change it (#250).
func TestTranscodingLoggedOnce(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	t.Cleanup(func() { slog.SetDefault(old) })
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	count := func(s string) int { return strings.Count(buf.String(), s) }

	_, srv := newFake(t, false)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	s.poll(context.Background())
	s.poll(context.Background())
	if count("transcodes on the CPU") != 1 || count("STREAMIQ_JELLYFIN_HWACCEL=nvenc") != 1 || count("hwaccel=off") != 1 {
		t.Fatalf("managed, off:\n%s", buf.String())
	}

	s2 := newSetup(t, srv.URL, &got) // a restart with the env var set
	s2.StateDir, s2.HWAccel = s.StateDir, "nvenc"
	if err := s2.Load(); err != nil {
		t.Fatal(err)
	}
	s2.poll(context.Background())
	if count("transcodes on the GPU") != 1 || count("hwaccel=nvenc") != 2 { // + the "applied" line
		t.Fatalf("managed, nvenc:\n%s", buf.String())
	}

	_, srv = newFake(t, true)
	s3 := newSetup(t, srv.URL, &got)
	if err := s3.Login(context.Background(), "me", "pw"); err != nil {
		t.Fatal(err)
	}
	s3.poll(context.Background())
	s3.poll(context.Background())
	if count("Dashboard → Playback → Transcoding") != 1 {
		t.Fatalf("unmanaged:\n%s", buf.String())
	}
}
