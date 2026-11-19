// Package jellyfin gets the gateway a non-admin Jellyfin user token without
// manual steps and watches Jellyfin's health for the status page (design:
// specs/2026-11-04-streamiq-gateway-productization-design.md, goals 4, 5, 7;
// viewer token: #50). With an admin session it creates (or adopts) the hidden
// viewer user "streamiq-viewer", signs in as it and keeps that token, then logs
// the admin out. The admin session comes from:
//   - fresh Jellyfin (wizard not done): complete the wizard, create admin
//     "streamiq" with a random password (kept only in state/jellyfin.json, 0600; the
//     local page shows the file's path, never the password). If a human changes it
//     in Jellyfin, a page login as "streamiq" stores the new one, and so does
//     editing the file (re-read when it changes, #240). A Jellyfin found back
//     in this state with creds stored (its data wiped, #280) is set up again
//     the same way, replacing all stored creds, BYO ones too;
//   - Jellyfin already set up: the local page asks once for an admin login (the
//     password typed is never stored); with it the gateway also creates its own
//     hidden admin "streamiq-admin" (random password, stored like above), so it can
//     create viewers later without asking again (#195).
//
// Each StreamIQ user also gets a hidden viewer of their own, "streamiq-<users.id>",
// created with the gateway's admin on the user's first session (#195), so
// resume and played state are per user; "streamiq-viewer" is the fallback.
//
// The viewers' own passwords are stored, so a revoked token repairs itself.
//
// Transcoding settings (#82): only on a Jellyfin the gateway set up, never on
// one the user brought (BYO), though both store an admin password. See configure.
package jellyfin

import (
	"cmp"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Tested is the Jellyfin major.minor this gateway release is tested with. Image
// and the pins in docker-compose.yml and install/jellyfin-compose.yml must match
// (TestPinsMatchTested).
const Tested = "12.4"

const (
	adminName  = "streamiq"        // the admin the wizard bootstrap creates (visible: the human manages Jellyfin with it)
	byoAdmin   = "streamiq-admin"  // the gateway's own hidden admin on BYO (#195); not "streamiq": a human may have that one
	ViewerName = "streamiq-viewer" // the shared viewer: fallback when a user's own one can't be made (#195)
	clientHdr  = `MediaBrowser Client="streamiq-gateway", Device="gateway", DeviceId="streamiq-gateway", Version="1"`
)

// Creds is state/jellyfin.json.
// Its JSON format changed? Update oldState in cmd/gateway/update_windows_test.go
// to the new format, in the same PR (the update test starts from it, #452).
type Creds struct {
	Token          string            `json:"token,omitempty"` // the viewer's access token
	Viewer         string            `json:"viewer,omitempty"`
	ViewerID       string            `json:"viewerId,omitempty"`
	ViewerPassword string            `json:"viewerPassword,omitempty"` // re-sign-in when the token is revoked
	User           string            `json:"user,omitempty"`           // the admin the gateway created
	Password       string            `json:"password,omitempty"`       // the admin the gateway created (wizard, or its own on BYO)
	BYO            bool              `json:"byo,omitempty"`            // the user brought this Jellyfin: hands off its settings
	ConfigSteps    int               `json:"configSteps,omitempty"`    // len(configSteps) applied (managed Jellyfin only)
	ServerSteps    int               `json:"serverSteps,omitempty"`    // len(serverSteps) applied (managed Jellyfin only)
	HWAccel        string            `json:"hwAccel,omitempty"`        // STREAMIQ_JELLYFIN_HWACCEL last applied
	Users          map[string]Viewer `json:"users,omitempty"`          // StreamIQ users.id → their own viewer (#195)
}

// Viewer is one StreamIQ user's own hidden Jellyfin user.
type Viewer struct {
	Name     string `json:"viewer"`
	ID       string `json:"viewerId"`
	Token    string `json:"token"`
	Password string `json:"password"` // re-sign-in when the token is revoked
}

// managed: the gateway set this Jellyfin up, so it owns the transcoding settings.
func (c Creds) managed() bool { return c.Password != "" && !c.BYO }

// View is what the status page shows.
type View struct {
	Reachable, NeedsLogin, HasKey bool
	Untested                      bool // reachable, but not the Tested major.minor
	Version, Tested, Err          string
	User, Viewer                  string
	Managed                       bool   // the gateway owns the transcoding settings (it set Jellyfin up)
	HWAccel                       string // applied STREAMIQ_JELLYFIN_HWACCEL
	PasswordFile                  string // set only if the gateway set Jellyfin up: where its admin's password is
}

// Setup runs the poll loop and the page's login. OnKey hands a new token and
// the Jellyfin user id it belongs to (the one to pin) to the tunnel.
type Setup struct {
	Client   *http.Client
	URL      string // e.g. http://localhost:8096
	StateDir string
	OnKey    func(token, userID string)
	HWAccel  string // STREAMIQ_JELLYFIN_HWACCEL, one of HWAccels

	vmu       sync.Mutex // held by whoever rewrites creds or signs in as the gateway's admin: EnsureViewer, check, configure, Login, bootstrap, Load
	mu        sync.Mutex
	creds     Creds
	reachable bool
	wizard    bool // wizard completed
	version   string
	err       string
	warned    string // version already warned about
	// refused: Jellyfin refused the gateway's admin while making a viewer. No
	// retry until the stored admin password changes (BYO: a page login; managed:
	// a page login as that admin, or an edit of the file): Jellyfin locks users out after failed sign-ins.
	refused bool
	logged  bool      // transcoding state logged (once per start; poll's goroutine only)
	mtime   time.Time // jellyfin.json as last read or written: an edit shows as a change (#240)
}

func (s *Setup) path() string { return filepath.Join(s.StateDir, "jellyfin.json") }

// Load reads stored creds, if the file changed since the last read or save, and
// installs the token, if any. At start, and on each poll: an edit of the file
// takes effect without a restart (#240). A file that doesn't parse keeps the
// creds in memory.
func (s *Setup) Load() error {
	s.vmu.Lock()
	defer s.vmu.Unlock()
	fi, err := os.Stat(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	s.mu.Lock()
	same := fi.ModTime().Equal(s.mtime)
	s.mu.Unlock()
	if same {
		return nil
	}
	b, err := os.ReadFile(s.path())
	if err != nil {
		return err
	}
	var c Creds
	if err := json.Unmarshal(b, &c); err != nil {
		return fmt.Errorf("%s: %w", s.path(), err)
	}
	s.mu.Lock()
	old := s.creds
	s.creds, s.mtime = c, fi.ModTime()
	if c.Password != old.Password { // new admin creds: retry, and drop the error that asked for them
		s.refused, s.err = false, ""
	}
	s.mu.Unlock()
	if c.Token != "" {
		s.OnKey(c.Token, c.ViewerID)
	}
	return nil
}

func (s *Setup) save(c Creds) error {
	b, _ := json.MarshalIndent(c, "", "  ")
	if err := os.WriteFile(s.path(), b, 0o600); err != nil {
		return err
	}
	fi, _ := os.Stat(s.path()) // ponytail: an edit landing between write and stat is missed until the next one
	s.mu.Lock()
	s.creds = c
	if fi != nil {
		s.mtime = fi.ModTime()
	}
	s.mu.Unlock()
	s.OnKey(c.Token, c.ViewerID)
	return nil
}

// Run polls Jellyfin until ctx ends: fast while it isn't usable yet, then
// every minute (status page, token check, tested-version warning).
func (s *Setup) Run(ctx context.Context) {
	for {
		s.poll(ctx)
		every := time.Minute
		if v := s.View(); !v.Reachable || !v.HasKey {
			every = 5 * time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
	}
}

func (s *Setup) poll(ctx context.Context) {
	s.reload()
	wizard, c, err := s.probe(ctx)
	switch {
	case err != nil:
	case !wizard && s.wiped(ctx, c): // first: set a wiped Jellyfin (#280) up again over stale creds
		if err := s.bootstrap(ctx); err != nil {
			s.setErr("Jellyfin setup: " + err.Error())
			slog.Error("gateway: Jellyfin setup failed", "err", err)
			return
		}
		slog.Info("gateway: completed the Jellyfin setup wizard", "admin", adminName, "password_in", s.path())
		s.configure(ctx) // seed now, not a poll later
	case c.Token != "" || len(c.Users) > 0:
		s.check(ctx)
		s.configure(ctx)
	}
	if v := s.View(); !s.logged && v.Reachable && v.HasKey {
		s.logged = true
		logTranscoding(v)
	}
}

// reload re-reads the stored creds; on an error it keeps the ones from before
// and says so on the status page until a re-read works.
func (s *Setup) reload() {
	const kept = " (kept the credentials from before)"
	if err := s.Load(); err != nil {
		s.setErr("Jellyfin: " + err.Error() + kept)
		slog.Error("gateway: could not re-read the Jellyfin credentials; kept the ones from before", "err", err)
	} else if strings.HasSuffix(s.View().Err, kept) {
		s.setErr("") // fixed
	}
}

// probe asks Jellyfin for its version and wizard state, records them, warns
// once per untested version, and returns the wizard state with the creds of
// that moment; err when Jellyfin isn't reachable.
func (s *Setup) probe(ctx context.Context) (wizard bool, c Creds, err error) {
	var info struct {
		Version                string
		StartupWizardCompleted bool
	}
	err = s.call(ctx, "GET", "/System/Info/Public", "", "", &info)
	s.mu.Lock()
	s.reachable, s.version, s.wizard = err == nil, info.Version, info.StartupWizardCompleted
	c = s.creds
	warn := err == nil && untested(info.Version) && s.warned != info.Version
	if warn {
		s.warned = info.Version
	}
	s.mu.Unlock()
	if warn {
		slog.Warn("gateway: Jellyfin version not tested with this release", "version", info.Version, "tested", Tested)
	}
	return info.StartupWizardCompleted, c, err
}

// wiped: Jellyfin (its wizard not done) has none of the stored creds, if any.
// A booting Jellyfin briefly reports the wizard not done too, but answers 503,
// not 401, so a restart never replaces working creds.
func (s *Setup) wiped(ctx context.Context, c Creds) bool {
	tok := c.Token
	for _, v := range c.Users {
		tok = cmp.Or(tok, v.Token)
	}
	if tok == "" {
		return true
	}
	if !unauthorized(s.call(ctx, "GET", "/Users/Me", tok, "", nil)) {
		return false
	}
	slog.Warn(
		"gateway: Jellyfin was reset (setup wizard not done, stored token refused); setting it up again and replacing the stored credentials",
		"file",
		s.path(),
	)
	return true
}

// logTranscoding says once per start how Jellyfin transcodes and where to
// change it (#250): without it, a GPU left off goes unnoticed.
func logTranscoding(v View) {
	switch {
	case !v.Managed:
		slog.Info(
			"gateway: Jellyfin transcoding is set in your own Jellyfin: Dashboard → Playback → Transcoding",
			"managed",
			false,
		)
	case v.HWAccel == "":
		slog.Info(
			"gateway: Jellyfin transcodes on the CPU; for an NVIDIA GPU set STREAMIQ_JELLYFIN_HWACCEL=nvenc in gateway.env (docs/install.md, \"GPU transcoding\")",
			"managed",
			true,
			"hwaccel",
			"off",
		)
	default:
		slog.Info("gateway: Jellyfin transcodes on the GPU", "managed", true, "hwaccel", v.HWAccel)
	}
}

func (s *Setup) setErr(e string) {
	s.mu.Lock()
	s.err = e
	s.mu.Unlock()
}

// bootstrap completes the startup wizard (the calls Jellyfin's own web wizard
// makes) and connects with the new admin.
// Replaces all stored creds (a reset Jellyfin has none of those users).
func (s *Setup) bootstrap(ctx context.Context) error {
	s.vmu.Lock() // EnsureViewer must not save old creds over the new ones
	defer s.vmu.Unlock()
	pw := randPassword()
	steps := []struct{ method, path, body string }{
		{
			"POST",
			"/Startup/Configuration",
			`{"UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}`,
		},
		{"GET", "/Startup/User", ""}, // the wizard expects this GET before the POST
		{"POST", "/Startup/User", fmt.Sprintf(`{"Name":%q,"Password":%q}`, adminName, pw)},
		{"POST", "/Startup/RemoteAccess", `{"EnableRemoteAccess":true,"EnableAutomaticPortMapping":false}`},
		{"POST", "/Startup/Complete", ""},
	}
	for _, st := range steps {
		if err := s.call(ctx, st.method, st.path, "", st.body, nil); err != nil {
			return err
		}
	}
	c, err := s.connect(ctx, adminName, pw, false)
	if err != nil {
		return err
	}
	c.User, c.Password = adminName, pw
	if err := s.save(c); err != nil {
		return err
	}
	s.mu.Lock() // under vmu: EnsureViewer must not see the old admin's refusal
	s.err, s.refused = "", false
	s.mu.Unlock()
	return nil
}

// Login connects with an existing admin's login (from the local page). The
// password typed is not stored, except on a Jellyfin the gateway set up when the
// login is as its own admin (streamiq): that password was in the file already,
// and storing it recovers one a human changed (#240).
func (s *Setup) Login(ctx context.Context, user, pw string) error {
	s.vmu.Lock()
	defer s.vmu.Unlock()
	s.mu.Lock()
	old := s.creds
	s.mu.Unlock()
	byo := !old.managed()
	if byo && strings.EqualFold(user, byoAdmin) {
		// the gateway resets this user's password below, which ends the very session it signs in with
		return fmt.Errorf("sign in with your own Jellyfin administrator, not %s", byoAdmin)
	}
	c, err := s.connect(ctx, user, pw, byo)
	if err != nil {
		return err
	}
	if !byo { // keep the bootstrapped admin's password for the human (and configure)
		c.User, c.Password, c.ConfigSteps, c.ServerSteps, c.HWAccel = old.User, old.Password, old.ConfigSteps, old.ServerSteps, old.HWAccel
		if pw != "" && strings.EqualFold(user, old.User) { // "" would make the gateway unmanaged (managed())
			c.Password = pw
		}
	}
	c.Users = old.Users // their passwords still work
	if err := s.save(c); err != nil {
		return err
	}
	s.mu.Lock()
	s.err = ""
	s.refused = s.refused && c.Password == old.Password // only new admin creds are worth a retry
	s.mu.Unlock()
	return nil
}

// connect signs in as an admin, ensures the gateway's own admin (ownAdmin, on
// BYO) and the viewer user, signs in as the viewer and logs the admin
// session out again.
func (s *Setup) connect(ctx context.Context, user, pw string, ownAdmin bool) (Creds, error) {
	admin, err := s.signIn(ctx, user, pw)
	if err != nil {
		return Creds{}, err
	}
	defer s.logout(ctx, admin)
	v, err := s.makeViewer(ctx, admin, ViewerName)
	if err != nil {
		return Creds{}, fmt.Errorf("create the viewer user (needs a Jellyfin administrator): %w", err)
	}
	c := Creds{Token: v.Token, Viewer: v.Name, ViewerID: v.ID, ViewerPassword: v.Password}
	if ownAdmin { // last: a failure before this leaves its stored password valid
		_, apw, err := s.ensureUser(ctx, admin, byoAdmin, true)
		if err != nil {
			return Creds{}, fmt.Errorf("create the gateway's admin user (needs a Jellyfin administrator): %w", err)
		}
		c.User, c.Password, c.BYO = byoAdmin, apw, true
	}
	return c, nil
}

// signIn returns an access token. Signing in again replaces this gateway's
// previous token for that user (same DeviceId), so tokens don't pile up.
func (s *Setup) signIn(ctx context.Context, user, pw string) (string, error) {
	var auth struct{ AccessToken string }
	body := fmt.Sprintf(`{"Username":%q,"Pw":%q}`, user, pw)
	if err := s.call(ctx, "POST", "/Users/AuthenticateByName", "", body, &auth); err != nil {
		return "", fmt.Errorf("sign in as %s: %w", user, err)
	}
	return auth.AccessToken, nil
}

// httpErr is a non-2xx Jellyfin response.
type httpErr struct {
	method, path string
	status       int
}

func (e httpErr) Error() string { return fmt.Sprintf("%s %s: HTTP %d", e.method, e.path, e.status) }

func unauthorized(err error) bool { return status(err) == http.StatusUnauthorized }

// status is a Jellyfin error's HTTP status, 0 if none.
func status(err error) int {
	var h httpErr
	if errors.As(err, &h) {
		return h.status
	}
	return 0
}

// logout ends an admin session. Best effort: a session left open only expires later.
func (s *Setup) logout(ctx context.Context, token string) {
	_ = s.call(context.WithoutCancel(ctx), "POST", "/Sessions/Logout", token, "", nil)
}

// call does one Jellyfin request; out (if non-nil) receives the JSON body.
func (s *Setup) call(ctx context.Context, method, path, token, body string, out any) error {
	return s.callT(ctx, 30*time.Second, method, path, token, body, out)
}

func (s *Setup) callT(ctx context.Context, timeout time.Duration, method, path, token, body string, out any) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, s.URL+path, strings.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	h := clientHdr
	if token != "" {
		h += `, Token="` + token + `"`
	}
	req.Header.Set("Authorization", h)
	resp, err := s.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		p, _, _ := strings.Cut(path, "?")
		return httpErr{method, p, resp.StatusCode}
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

// View is a snapshot for the status page.
func (s *Setup) View() View {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.creds
	v := View{
		Reachable: s.reachable, Version: s.version, Tested: Tested, Err: s.err,
		HasKey: c.Token != "", Untested: s.reachable && untested(s.version),
		// also offered on BYO until the gateway has its own admin (#195)
		// and when the gateway's admin was refused (BYO: a login makes it again; managed: one as it stores its new password, #240)
		NeedsLogin: s.reachable && s.wizard && (c.Token == "" || c.Password == "" || s.refused),
		User:       c.User, Viewer: c.Viewer,
		Managed: c.managed(), HWAccel: c.HWAccel,
	}
	if c.managed() { // never the password itself: the page is open to the whole LAN
		v.PasswordFile, _ = filepath.Abs(s.path())
	}
	return v
}

// Transcoding is the gateway API's transcoding setting (#146): the applied
// STREAMIQ_JELLYFIN_HWACCEL ("nvenc", or "none") on a Jellyfin the gateway set
// up, else "unmanaged". The setting is the honest answer: Jellyfin doesn't fall
// back to the CPU silently (a broken GPU setup fails the transcode; #86).
func (v View) Transcoding() string {
	switch {
	case !v.Managed:
		return "unmanaged"
	case v.HWAccel == "":
		return "none"
	}
	return v.HWAccel
}

// Token is the credential state for the heartbeat: "ok" or "missing".
func (v View) Token() string {
	if v.HasKey {
		return "ok"
	}
	return "missing"
}

func untested(version string) bool { return !strings.HasPrefix(version, Tested+".") }

func randPassword() string {
	b := make([]byte, 18)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
