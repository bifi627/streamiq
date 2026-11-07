// Package jellyfin gets the gateway its Jellyfin API key without manual steps
// and watches Jellyfin's health for the status page (design:
// specs/2026-11-04-streamiq-gateway-productization-design.md, goals 4, 5, 7):
//   - fresh Jellyfin (wizard not done): complete the wizard, create admin
//     "streamiq" with a random password (kept only in state/jellyfin.json, 0600; the
//     local page shows the file's path, never the password), mint a key;
//   - Jellyfin already set up: the local page asks once for an admin login; the
//     gateway mints a key with it and stores the key, never the password;
//   - STREAMIQ_JELLYFIN_API_KEY still wins (dev, e2e): Fixed skips both.
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
	adminName = "streamiq"
	app       = "streamiq-gateway"
	clientHdr = `MediaBrowser Client="streamiq-gateway", Device="gateway", DeviceId="streamiq-gateway", Version="1"`
)

// Creds is state/jellyfin.json.
type Creds struct {
	APIKey   string `json:"apiKey"`
	User     string `json:"user"`               // the household Jellyfin user the tunnel pins
	Password string `json:"password,omitempty"` // only when the gateway created the admin
}

// View is what the status page shows.
type View struct {
	Reachable, NeedsLogin, Fixed, HasKey bool
	Untested                             bool // reachable, but not the Tested major.minor
	Version, Tested, Err                 string
	User                                 string
	PasswordFile                         string // set only if the gateway created the admin: where its password is
}

// Setup runs the poll loop and the page's login. OnKey hands a new key (and the
// user to pin) to the tunnel.
type Setup struct {
	Client   *http.Client
	URL      string // e.g. http://localhost:8096
	StateDir string
	Fixed    bool // STREAMIQ_JELLYFIN_API_KEY set: never bootstrap or ask for a login
	OnKey    func(key, user string)

	mu        sync.Mutex
	creds     Creds
	reachable bool
	wizard    bool // wizard completed
	version   string
	err       string
	warned    string // version already warned about
}

func (s *Setup) path() string { return filepath.Join(s.StateDir, "jellyfin.json") }

// Load reads stored creds and installs the key, if any.
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
	if c.APIKey != "" && !s.Fixed {
		s.OnKey(c.APIKey, c.User)
	}
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
	s.OnKey(c.APIKey, c.User)
	return nil
}

// Run polls Jellyfin until ctx ends: fast while it isn't usable yet, then
// every minute (status page + tested-version warning).
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
	needBootstrap := err == nil && !info.StartupWizardCompleted && s.creds.APIKey == "" && !s.Fixed
	warn := err == nil && untested(info.Version) && s.warned != info.Version
	if warn {
		s.warned = info.Version
	}
	s.mu.Unlock()
	if warn {
		slog.Warn("gateway: Jellyfin version not tested with this release", "version", info.Version, "tested", Tested)
	}
	if needBootstrap {
		if err := s.bootstrap(ctx); err != nil {
			s.setErr("Jellyfin setup: " + err.Error())
			slog.Error("gateway: Jellyfin setup failed", "err", err)
			return
		}
		s.setErr("")
		slog.Info("gateway: completed the Jellyfin setup wizard", "admin", adminName, "password_in", s.path())
	}
}

func (s *Setup) setErr(e string) {
	s.mu.Lock()
	s.err = e
	s.mu.Unlock()
}

// bootstrap completes the startup wizard (the calls Jellyfin's own web wizard
// makes) and mints a key with the new admin.
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
	key, err := s.mint(ctx, adminName, pw)
	if err != nil {
		return err
	}
	return s.save(Creds{APIKey: key, User: adminName, Password: pw})
}

// Login mints a key with an existing admin's login (from the local page) and
// stores the key, not the password.
func (s *Setup) Login(ctx context.Context, user, pw string) error {
	if s.Fixed {
		return errors.New("STREAMIQ_JELLYFIN_API_KEY is set")
	}
	key, err := s.mint(ctx, user, pw)
	if err != nil {
		return err
	}
	return s.save(Creds{APIKey: key, User: user})
}

// mint signs in, creates an API key named streamiq-gateway, and signs the
// session out again so no password session lingers.
func (s *Setup) mint(ctx context.Context, user, pw string) (string, error) {
	var auth struct{ AccessToken string }
	body := fmt.Sprintf(`{"Username":%q,"Pw":%q}`, user, pw)
	if err := s.call(ctx, "POST", "/Users/AuthenticateByName", "", body, &auth); err != nil {
		return "", fmt.Errorf("sign in as %s: %w", user, err)
	}
	tok := auth.AccessToken
	defer s.call(context.WithoutCancel(ctx), "POST", "/Sessions/Logout", tok, "", nil)
	if err := s.call(ctx, "POST", "/Auth/Keys?app="+app, tok, "", nil); err != nil {
		return "", fmt.Errorf("create API key (needs a Jellyfin administrator): %w", err)
	}
	var keys struct {
		Items []struct{ AccessToken, AppName string }
	}
	if err := s.call(ctx, "GET", "/Auth/Keys", tok, "", &keys); err != nil {
		return "", err
	}
	for i := len(keys.Items) - 1; i >= 0; i-- { // newest last
		if keys.Items[i].AppName == app {
			return keys.Items[i].AccessToken, nil
		}
	}
	return "", errors.New("created API key not listed")
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
		return fmt.Errorf("%s %s: HTTP %d", method, path, resp.StatusCode)
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
	has := s.creds.APIKey != "" || s.Fixed
	v := View{
		Reachable: s.reachable, Version: s.version, Tested: Tested, Err: s.err,
		Fixed: s.Fixed, HasKey: has, Untested: s.reachable && untested(s.version), NeedsLogin: s.reachable && s.wizard && !has,
		User: s.creds.User,
	}
	if s.creds.Password != "" { // never the password itself: the page is open to the whole LAN
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
