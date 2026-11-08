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
//     admin password is never stored).
//
// The viewer's own password is stored, so a revoked token repairs itself.
// Files from before #50 hold an admin API key: it keeps working until the next
// page login, which replaces it and deletes the key in Jellyfin.
//
// Transcoding settings (#82): only on a Jellyfin the gateway set up (admin
// password stored), never on one the user brought. See configure.
package jellyfin

import (
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

// Tested is the Jellyfin major.minor this gateway release is tested with. The
// image pins in docker-compose.yml and install/jellyfin-compose.yml must match
// (TestPinsMatchTested).
const Tested = "12.4"

const (
	adminName  = "streamiq"
	ViewerName = "streamiq-viewer" // per-member profiles later: one viewer per member
	clientHdr  = `MediaBrowser Client="streamiq-gateway", Device="gateway", DeviceId="streamiq-gateway", Version="1"`
)

// Creds is state/jellyfin.json.
type Creds struct {
	Token          string `json:"token,omitempty"` // the viewer's access token
	Viewer         string `json:"viewer,omitempty"`
	ViewerID       string `json:"viewerId,omitempty"`
	ViewerPassword string `json:"viewerPassword,omitempty"` // re-sign-in when the token is revoked
	User           string `json:"user,omitempty"`           // the admin the gateway created; before #50: the user the key was pinned to
	Password       string `json:"password,omitempty"`       // only when the gateway created the admin
	APIKey         string `json:"apiKey,omitempty"`         // before #50: an admin API key
	ConfigSteps    int    `json:"configSteps,omitempty"`    // len(configSteps) applied (managed Jellyfin only)
	HWAccel        string `json:"hwAccel,omitempty"`        // STREAMIQ_JELLYFIN_HWACCEL last applied
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
	PasswordFile                  string // set only if the gateway created the admin: where its password is
}

// Setup runs the poll loop and the page's login. OnKey hands a new token and
// the Jellyfin user id it belongs to (the one to pin) to the tunnel.
type Setup struct {
	Client   *http.Client
	URL      string // e.g. http://localhost:8096
	StateDir string
	OnKey    func(token, userID string)
	HWAccel  string // STREAMIQ_JELLYFIN_HWACCEL, one of HWAccels

	mu        sync.Mutex
	creds     Creds
	legacyID  string // user id resolved for a pre-#50 API key
	reachable bool
	wizard    bool // wizard completed
	version   string
	err       string
	warned    string // version already warned about
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
	case c.Token != "":
		s.check(ctx, c)
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
	c, err := s.connect(ctx, adminName, pw, "")
	if err != nil {
		return err
	}
	c.User, c.Password = adminName, pw
	return s.save(c)
}

// Login connects with an existing admin's login (from the local page). The
// admin password is not stored. A pre-#50 API key is deleted in Jellyfin.
func (s *Setup) Login(ctx context.Context, user, pw string) error {
	s.mu.Lock()
	old := s.creds
	s.mu.Unlock()
	c, err := s.connect(ctx, user, pw, old.APIKey)
	if err != nil {
		return err
	}
	if old.Password != "" { // keep the bootstrapped admin's password for the human (and configure)
		c.User, c.Password, c.ConfigSteps, c.HWAccel = old.User, old.Password, old.ConfigSteps, old.HWAccel
	}
	if err := s.save(c); err != nil {
		return err
	}
	s.setErr("")
	return nil
}

// connect signs in as an admin, ensures the viewer user, signs in as the
// viewer, deletes oldKey (if any) and logs the admin session out again.
func (s *Setup) connect(ctx context.Context, user, pw, oldKey string) (Creds, error) {
	admin, err := s.signIn(ctx, user, pw)
	if err != nil {
		return Creds{}, err
	}
	defer s.call(context.WithoutCancel(ctx), "POST", "/Sessions/Logout", admin, "", nil)
	id, vpw, err := s.ensureViewer(ctx, admin, ViewerName)
	if err != nil {
		return Creds{}, fmt.Errorf("create the viewer user (needs a Jellyfin administrator): %w", err)
	}
	tok, err := s.signIn(ctx, ViewerName, vpw)
	if err != nil {
		return Creds{}, err
	}
	if oldKey != "" {
		// No err in the log: the request URL (in a transport error) holds the key.
		if s.call(ctx, "DELETE", "/Auth/Keys/"+oldKey, admin, "", nil) != nil {
			slog.Warn("gateway: could not delete the old Jellyfin API key; delete streamiq-gateway in Dashboard → API Keys")
		}
	}
	return Creds{Token: tok, Viewer: ViewerName, ViewerID: id, ViewerPassword: vpw}, nil
}

// ensureViewer creates the hidden non-admin user name with a random password,
// or adopts an existing one by setting a new password, then sets its policy.
// The policy goes back whole (Jellyfin requires every field), so fields this
// code doesn't know survive. Idempotent: a half-finished run is just repeated.
func (s *Setup) ensureViewer(ctx context.Context, admin, name string) (id, pw string, err error) {
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
	for k, v := range map[string]any{
		"IsAdministrator": false, "IsHidden": true, "IsDisabled": false,
		"EnableContentDeletion": false, "EnableContentDeletionFromFolders": []string{},
		"EnableRemoteControlOfOtherUsers": false, "EnableSharedDeviceControl": false,
		"EnablePublicSharing": false, "EnableCollectionManagement": false,
		"EnableSubtitleManagement": false, "EnableLyricManagement": false, "EnableLiveTvManagement": false,
	} {
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
	s.mu.Lock()
	c := s.creds
	s.mu.Unlock()
	if c.Token == "" || c.Password == "" || (c.ConfigSteps >= len(configSteps) && c.HWAccel == s.HWAccel) {
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

// check repairs a revoked viewer token by signing in again with the stored
// viewer password. If Jellyfin refuses that too, the token is dropped and the
// page asks for an admin login.
func (s *Setup) check(ctx context.Context, c Creds) {
	if err := s.call(ctx, "GET", "/Users/Me", c.Token, "", nil); !unauthorized(err) {
		return
	}
	tok, err := s.signIn(ctx, c.Viewer, c.ViewerPassword)
	switch {
	case err == nil:
		c.Token = tok
		slog.Info("gateway: Jellyfin token was revoked; signed in again", "user", c.Viewer)
	case unauthorized(err):
		c.Token = ""
		slog.Error("gateway: Jellyfin refused the viewer sign-in; reconnect Jellyfin on the local page", "user", c.Viewer)
	default:
		s.setErr("Jellyfin: " + err.Error()) // transient: retried next poll
		return
	}
	if err := s.save(c); err != nil {
		s.setErr("Jellyfin: " + err.Error())
	}
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
		NeedsLogin: s.reachable && s.wizard && c.Token == "", // also offered to move off a legacy key
		User:       c.User, Viewer: c.Viewer,
		Managed: c.Password != "", HWAccel: c.HWAccel,
	}
	if c.Password != "" { // never the password itself: the page is open to the whole LAN
		v.PasswordFile, _ = filepath.Abs(s.path())
	}
	return v
}

func untested(version string) bool { return !strings.HasPrefix(version, Tested+".") }

func randPassword() string {
	b := make([]byte, 18)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
