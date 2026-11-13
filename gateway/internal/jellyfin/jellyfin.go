// Package jellyfin gets the gateway a non-admin Jellyfin user token without
// manual steps and watches Jellyfin's health for the status page (design:
// specs/2026-11-04-streamiq-gateway-productization-design.md, goals 4, 5, 7;
// viewer token: #50). With an admin session it creates (or adopts) the hidden
// viewer user "streamiq-viewer", signs in as it and keeps that token, then logs
// the admin out. The admin session comes from:
//   - fresh Jellyfin (wizard not done): complete the wizard, create admin
//     "streamiq" with a random password (kept only in state/jellyfin.json, 0600; the
//     local page shows the file's path, never the password);
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
// Files from before #50 hold an admin API key: it keeps working until the next
// page login, which replaces it and deletes the key in Jellyfin.
//
// Transcoding settings (#82): only on a Jellyfin the gateway set up, never on
// one the user brought (BYO), though both store an admin password. See configure.
package jellyfin

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
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
type Creds struct {
	Token          string            `json:"token,omitempty"` // the viewer's access token
	Viewer         string            `json:"viewer,omitempty"`
	ViewerID       string            `json:"viewerId,omitempty"`
	ViewerPassword string            `json:"viewerPassword,omitempty"` // re-sign-in when the token is revoked
	User           string            `json:"user,omitempty"`           // the admin the gateway created; before #50: the user the key was pinned to
	Password       string            `json:"password,omitempty"`       // the admin the gateway created (wizard, or its own on BYO)
	BYO            bool              `json:"byo,omitempty"`            // the user brought this Jellyfin: hands off its settings
	APIKey         string            `json:"apiKey,omitempty"`         // before #50: an admin API key
	ConfigSteps    int               `json:"configSteps,omitempty"`    // len(configSteps) applied (managed Jellyfin only)
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

// configSteps are the encoding settings the gateway owns, applied in order and
// once each to a Jellyfin it set up: a fresh one gets all, an existing one the
// ones added since its last update. Append only, never edit or reorder: the
// count applied is stored. Each step sets only its own fields, so a field
// the user changed in the Dashboard later stays changed.
var configSteps = []func(enc map[string]any){
	func(enc map[string]any) { // #82: stop encoding far ahead of the player, delete old segments
		enc["EnableThrottling"], enc["EnableSegmentDeletion"] = true, true
	},
}

// managed: the gateway set this Jellyfin up, so it owns the transcoding settings.
func (c Creds) managed() bool { return c.Password != "" && !c.BYO }

// HWAccels are the STREAMIQ_JELLYFIN_HWACCEL values ("" = none).
var HWAccels = []string{"", "nvenc"}

// hwAccel switches hardware transcoding. NVENC without a GPU in the container
// makes every transcode fail (no CPU fallback), so it is opt-in. Turning it
// off leaves the other fields alone: they do nothing without an accelerator.
func hwAccel(enc map[string]any, kind string) {
	if kind == "" {
		enc["HardwareAccelerationType"] = "none"
		return
	}
	for k, v := range map[string]any{
		"HardwareAccelerationType":       kind,
		"HardwareDecodingCodecs":         []string{"h264", "hevc", "mpeg2video", "vc1", "vp8", "vp9", "av1"},
		"EnableDecodingColorDepth10Hevc": true, "EnableDecodingColorDepth10Vp9": true,
		"EnableDecodingColorDepth10HevcRext": false, "EnableDecodingColorDepth12HevcRext": false,
		"EnableEnhancedNvdecDecoder": true, "EnableHardwareEncoding": true,
		"AllowHevcEncoding": false, "AllowAv1Encoding": false, // the browser may not play what comes out
		"EnableTonemapping": true,
		"EncoderPreset":     "fast", // "auto" is NVENC's lowest quality (p1)
	} {
		enc[k] = v
	}
}

// View is what the status page shows.
type View struct {
	Reachable, NeedsLogin, HasKey bool
	LegacyKey                     bool // still on a pre-#50 admin API key
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

	vmu       sync.Mutex // held by whoever rewrites creds or signs in as the gateway's admin: EnsureViewer, check, configure, Login
	mu        sync.Mutex
	creds     Creds
	legacyID  string // user id resolved for a pre-#50 API key
	reachable bool
	wizard    bool // wizard completed
	version   string
	err       string
	warned    string // version already warned about
	// refused: Jellyfin refused the gateway's admin while making a viewer. No
	// retry until the next page login: Jellyfin locks a user out after failed sign-ins.
	refused bool
}

func (s *Setup) path() string { return filepath.Join(s.StateDir, "jellyfin.json") }

// Load reads stored creds and installs the token, if any.
func (s *Setup) Load() error {
	b, err := os.ReadFile(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var c Creds
	if err := json.Unmarshal(b, &c); err != nil {
		return fmt.Errorf("%s: %w", s.path(), err)
	}
	s.mu.Lock()
	s.creds = c
	s.mu.Unlock()
	if c.Token != "" {
		s.OnKey(c.Token, c.ViewerID)
	} // a pre-#50 API key is installed by poll once its user id is resolved
	return nil
}

func (s *Setup) save(c Creds) error {
	b, _ := json.MarshalIndent(c, "", "  ")
	if err := os.WriteFile(s.path(), b, 0o600); err != nil {
		return err
	}
	s.mu.Lock()
	s.creds = c
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
	var info struct {
		Version                string
		StartupWizardCompleted bool
	}
	err := s.call(ctx, "GET", "/System/Info/Public", "", "", &info)
	s.mu.Lock()
	s.reachable, s.version, s.wizard = err == nil, info.Version, info.StartupWizardCompleted
	c, legacyID := s.creds, s.legacyID
	warn := err == nil && untested(info.Version) && s.warned != info.Version
	if warn {
		s.warned = info.Version
	}
	s.mu.Unlock()
	if warn {
		slog.Warn("gateway: Jellyfin version not tested with this release", "version", info.Version, "tested", Tested)
	}
	switch {
	case err != nil:
	case c.Token != "" || len(c.Users) > 0:
		s.check(ctx)
		s.configure(ctx)
	case c.APIKey != "":
		if legacyID == "" {
			s.legacy(ctx, c)
		}
	case !info.StartupWizardCompleted:
		if err := s.bootstrap(ctx); err != nil {
			s.setErr("Jellyfin setup: " + err.Error())
			slog.Error("gateway: Jellyfin setup failed", "err", err)
			return
		}
		s.setErr("")
		slog.Info("gateway: completed the Jellyfin setup wizard", "admin", adminName, "password_in", s.path())
		s.configure(ctx) // seed now, not a poll later
	}
}

func (s *Setup) setErr(e string) {
	s.mu.Lock()
	s.err = e
	s.mu.Unlock()
}

// bootstrap completes the startup wizard (the calls Jellyfin's own web wizard
// makes) and connects with the new admin.
func (s *Setup) bootstrap(ctx context.Context) error {
	pw := randPassword()
	steps := []struct{ method, path, body string }{
		{"POST", "/Startup/Configuration", `{"UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}`},
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
	c, err := s.connect(ctx, adminName, pw, "", false)
	if err != nil {
		return err
	}
	c.User, c.Password = adminName, pw
	return s.save(c)
}

// Login connects with an existing admin's login (from the local page). The
// password typed is not stored. A pre-#50 API key is deleted in Jellyfin.
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
	c, err := s.connect(ctx, user, pw, old.APIKey, byo)
	if err != nil {
		return err
	}
	if !byo { // keep the bootstrapped admin's password for the human (and configure)
		c.User, c.Password, c.ConfigSteps, c.HWAccel = old.User, old.Password, old.ConfigSteps, old.HWAccel
	}
	c.Users = old.Users // their passwords still work
	if err := s.save(c); err != nil {
		return err
	}
	s.mu.Lock()
	s.err, s.refused = "", false
	s.mu.Unlock()
	return nil
}

// connect signs in as an admin, ensures the gateway's own admin (ownAdmin, on
// BYO) and the viewer user, signs in as the viewer, deletes oldKey (if any)
// and logs the admin session out again.
func (s *Setup) connect(ctx context.Context, user, pw, oldKey string, ownAdmin bool) (Creds, error) {
	admin, err := s.signIn(ctx, user, pw)
	if err != nil {
		return Creds{}, err
	}
	defer s.call(context.WithoutCancel(ctx), "POST", "/Sessions/Logout", admin, "", nil)
	v, err := s.makeViewer(ctx, admin, ViewerName)
	if err != nil {
		return Creds{}, fmt.Errorf("create the viewer user (needs a Jellyfin administrator): %w", err)
	}
	if oldKey != "" {
		// No err in the log: the request URL (in a transport error) holds the key.
		if s.call(ctx, "DELETE", "/Auth/Keys/"+oldKey, admin, "", nil) != nil {
			slog.Warn("gateway: could not delete the old Jellyfin API key; delete streamiq-gateway in Dashboard → API Keys")
		}
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

// makeViewer creates (or adopts) the viewer user name and signs in as it.
func (s *Setup) makeViewer(ctx context.Context, admin, name string) (Viewer, error) {
	id, pw, err := s.ensureUser(ctx, admin, name, false)
	if err != nil {
		return Viewer{}, err
	}
	tok, err := s.signIn(ctx, name, pw)
	if err != nil {
		return Viewer{}, err
	}
	return Viewer{Name: name, ID: id, Token: tok, Password: pw}, nil
}

// ensureUser creates the hidden user name with a random password, or adopts an
// existing one by setting a new password, then sets its policy: a viewer
// (non-admin, no management rights) or the gateway's own admin.
// The policy goes back whole (Jellyfin requires every field), so fields this
// code doesn't know survive. Idempotent: a half-finished run is just repeated.
func (s *Setup) ensureUser(ctx context.Context, admin, name string, isAdmin bool) (id, pw string, err error) {
	type user struct {
		Name, Id string
		Policy   map[string]any
	}
	pw = randPassword()
	var users []user
	if err := s.call(ctx, "GET", "/Users", admin, "", &users); err != nil {
		return "", "", err
	}
	var u *user
	for i := range users {
		if strings.EqualFold(users[i].Name, name) {
			u = &users[i]
		}
	}
	if u != nil { // also revokes its old tokens
		if err := s.call(ctx, "POST", "/Users/"+u.Id+"/Password", admin, fmt.Sprintf(`{"NewPw":%q}`, pw), nil); err != nil {
			return "", "", err
		}
	} else {
		u = &user{}
		if err := s.call(ctx, "POST", "/Users/New", admin, fmt.Sprintf(`{"Name":%q,"Password":%q}`, name, pw), u); err != nil {
			return "", "", err
		}
	}
	if u.Policy == nil {
		return "", "", errors.New("Jellyfin returned no user policy")
	}
	policy := map[string]any{
		"IsAdministrator": false, "IsHidden": true, "IsDisabled": false,
		"EnableContentDeletion": false, "EnableContentDeletionFromFolders": []string{},
		"EnableRemoteControlOfOtherUsers": false, "EnableSharedDeviceControl": false,
		"EnablePublicSharing": false, "EnableCollectionManagement": false,
		"EnableSubtitleManagement": false, "EnableLyricManagement": false, "EnableLiveTvManagement": false,
	}
	if isAdmin {
		policy = map[string]any{"IsAdministrator": true, "IsHidden": true, "IsDisabled": false}
	}
	for k, v := range policy {
		u.Policy[k] = v
	}
	b, _ := json.Marshal(u.Policy)
	if err := s.call(ctx, "POST", "/Users/"+u.Id+"/Policy", admin, string(b), nil); err != nil {
		return "", "", err
	}
	return u.Id, pw, nil
}

// configure applies pending configSteps and a changed HWAccel to a Jellyfin
// the gateway set up, as its stored admin. A failure (e.g. the user changed
// that password) shows on the page and is retried next poll; playback runs on
// the viewer token either way.
func (s *Setup) configure(ctx context.Context) {
	s.vmu.Lock()
	defer s.vmu.Unlock()
	s.mu.Lock()
	c := s.creds
	s.mu.Unlock()
	if c.Token == "" || !c.managed() || (c.ConfigSteps >= len(configSteps) && c.HWAccel == s.HWAccel) {
		return
	}
	if err := s.applyConfig(ctx, c); err != nil {
		s.setErr("Jellyfin transcoding settings: " + err.Error())
		slog.Error("gateway: Jellyfin transcoding settings not applied", "err", err)
		return
	}
	s.setErr("")
	slog.Info("gateway: applied Jellyfin transcoding settings", "steps", len(configSteps), "hwaccel", s.HWAccel)
}

func (s *Setup) applyConfig(ctx context.Context, c Creds) error {
	admin, err := s.signIn(ctx, c.User, c.Password)
	if err != nil {
		return err
	}
	defer s.call(context.WithoutCancel(ctx), "POST", "/Sessions/Logout", admin, "", nil)
	// Whole object back, like the viewer policy: fields this code doesn't know survive.
	var enc map[string]any
	if err := s.call(ctx, "GET", "/System/Configuration/encoding", admin, "", &enc); err != nil {
		return err
	}
	for _, step := range configSteps[min(c.ConfigSteps, len(configSteps)):] {
		step(enc)
	}
	if c.HWAccel != s.HWAccel {
		hwAccel(enc, s.HWAccel)
	}
	b, _ := json.Marshal(enc)
	if err := s.call(ctx, "POST", "/System/Configuration/encoding", admin, string(b), nil); err != nil {
		return err
	}
	s.mu.Lock()
	c = s.creds // a page login may have replaced the token meanwhile
	s.mu.Unlock()
	c.ConfigSteps, c.HWAccel = len(configSteps), s.HWAccel
	return s.save(c)
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

// check repairs revoked viewer tokens by signing in again with the stored
// viewer passwords. If Jellyfin refuses the shared viewer's too, its token is
// dropped and the page asks for an admin login; a refused user's viewer is
// dropped and made again on their next session.
func (s *Setup) check(ctx context.Context) {
	s.vmu.Lock()
	defer s.vmu.Unlock()
	s.mu.Lock()
	c := s.creds
	s.mu.Unlock()
	tok := ""
	if c.Token != "" { // dropped: only a page login brings it back
		var err error
		if tok, err = s.renew(ctx, c.Token, c.Viewer, c.ViewerPassword); err != nil {
			s.setErr("Jellyfin: " + err.Error()) // transient: retried next poll
			return
		}
		if tok == "" {
			slog.Error("gateway: reconnect Jellyfin on the local page")
		}
	}
	users := map[string]Viewer{}
	for u, v := range c.Users {
		t, err := s.renew(ctx, v.Token, v.Name, v.Password)
		if err != nil {
			s.setErr("Jellyfin: " + err.Error())
		}
		if t != "" {
			v.Token = t
			users[u] = v
		}
	}
	if tok == c.Token && maps.Equal(users, c.Users) {
		return
	}
	c.Token, c.Users = tok, users
	if err := s.save(c); err != nil {
		s.setErr("Jellyfin: " + err.Error())
	}
}

// renew returns tok if Jellyfin still accepts it, else a new token for name;
// "" if Jellyfin refuses the password, tok and an error if Jellyfin is unreachable.
func (s *Setup) renew(ctx context.Context, tok, name, pw string) (string, error) {
	if err := s.call(ctx, "GET", "/Users/Me", tok, "", nil); !unauthorized(err) {
		return tok, nil
	}
	t, err := s.signIn(ctx, name, pw)
	switch {
	case err == nil:
		slog.Info("gateway: Jellyfin token was revoked; signed in again", "user", name)
		return t, nil
	case unauthorized(err):
		slog.Error("gateway: Jellyfin refused the viewer sign-in; dropped its token", "user", name)
		return "", nil
	}
	return tok, err
}

var userID = regexp.MustCompile(`^[0-9a-fA-F-]{32,36}$`)

// EnsureViewer gives a StreamIQ user their own viewer on their first session
// (#195); later sessions find it. If that fails, the session plays as the
// shared viewer, the log and the page say why, and the next session tries again.
func (s *Setup) EnsureViewer(ctx context.Context, user string) {
	user = strings.ToLower(user)
	s.vmu.Lock() // also: two sessions of a new user at once make one viewer
	defer s.vmu.Unlock()
	s.mu.Lock()
	c, refused := s.creds, s.refused
	s.mu.Unlock()
	if _, ok := c.Users[user]; ok || refused {
		return
	}
	v, err := s.newViewer(ctx, c, user)
	if err != nil {
		fix := "reconnect Jellyfin"
		if c.managed() {
			fix = "changed the " + c.User + " password? Put the new one in " + s.path() + " (password) and restart the gateway"
		}
		s.mu.Lock()
		s.err = "Jellyfin user for a member (they play as " + ViewerName + " meanwhile; " + fix + "): " + err.Error()
		s.refused = unauthorized(err)
		s.mu.Unlock()
		slog.Error("gateway: could not create a user's own Jellyfin viewer; the session plays as "+ViewerName, "user", user, "err", err)
		return
	}
	s.mu.Lock()
	c = s.creds
	s.mu.Unlock()
	c.Users = maps.Clone(c.Users) // the old map is still s.creds' until save
	if c.Users == nil {
		c.Users = map[string]Viewer{}
	}
	c.Users[user] = v
	if err := s.save(c); err != nil {
		s.setErr("Jellyfin: " + err.Error())
		return
	}
	s.setErr("")
	slog.Info("gateway: created a user's own Jellyfin viewer", "user", user, "viewer", v.Name)
}

func (s *Setup) newViewer(ctx context.Context, c Creds, user string) (Viewer, error) {
	if !userID.MatchString(user) {
		return Viewer{}, fmt.Errorf("bad user id %q", user)
	}
	if c.Password == "" {
		return Viewer{}, errors.New("the gateway has no Jellyfin administrator of its own")
	}
	admin, err := s.signIn(ctx, c.User, c.Password)
	if err != nil {
		return Viewer{}, err
	}
	defer s.call(context.WithoutCancel(ctx), "POST", "/Sessions/Logout", admin, "", nil)
	return s.makeViewer(ctx, admin, "streamiq-"+user)
}

// ViewerFor is a user's own viewer token and Jellyfin user id; "" if they have
// none (yet), so the tunnel uses the shared viewer.
func (s *Setup) ViewerFor(user string) (token, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := s.creds.Users[strings.ToLower(user)]
	return v.Token, v.ID
}

// legacy resolves the user a pre-#50 API key is pinned to and installs the key.
func (s *Setup) legacy(ctx context.Context, c Creds) {
	var users []struct{ Name, Id string }
	if err := s.call(ctx, "GET", "/Users", c.APIKey, "", &users); err != nil {
		s.setErr("Jellyfin API key: " + err.Error())
		return
	}
	for _, u := range users {
		if strings.EqualFold(u.Name, c.User) {
			s.mu.Lock()
			s.legacyID = u.Id
			s.mu.Unlock()
			s.OnKey(c.APIKey, u.Id)
			return
		}
	}
	s.setErr(fmt.Sprintf("Jellyfin user %q not found: reconnect Jellyfin", c.User))
}

// httpErr is a non-2xx Jellyfin response.
type httpErr struct {
	method, path string
	status       int
}

func (e httpErr) Error() string { return fmt.Sprintf("%s %s: HTTP %d", e.method, e.path, e.status) }

func unauthorized(err error) bool {
	var h httpErr
	return errors.As(err, &h) && h.status == http.StatusUnauthorized
}

// call does one Jellyfin request; out (if non-nil) receives the JSON body.
func (s *Setup) call(ctx context.Context, method, path, token, body string, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
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
	legacy := c.Token == "" && c.APIKey != ""
	v := View{
		Reachable: s.reachable, Version: s.version, Tested: Tested, Err: s.err,
		HasKey: c.Token != "" || legacy, LegacyKey: legacy, Untested: s.reachable && untested(s.version),
		// also offered to move off a legacy key, and on BYO until the gateway has its own admin (#195)
		// and when the gateway's own admin on BYO was refused (a login makes it again)
		NeedsLogin: s.reachable && s.wizard && (c.Token == "" || c.Password == "" || (s.refused && !c.managed())),
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

// Token is the credential state for the heartbeat: "ok", "legacy" (pre-#50
// admin API key) or "missing".
func (v View) Token() string {
	switch {
	case v.LegacyKey:
		return "legacy"
	case v.HasKey:
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
