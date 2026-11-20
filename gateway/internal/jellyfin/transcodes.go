package jellyfin

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// teleHdr is Transcodes' client: its own DeviceId, so the gateway's other admin
// sign-ins (same user, clientHdr's DeviceId) don't replace its token, and a
// restart's sign-in replaces the last run's instead of piling up.
const teleHdr = `MediaBrowser Client="streamiq-gateway", Device="gateway telemetry", DeviceId="streamiq-gateway-telemetry", Version="1"`

// Transcodes counts Jellyfin's sessions that transcode now (telemetry), read
// with the gateway's own admin. It keeps the admin's token between calls and
// signs in again only when Jellyfin rejects it. An error when there's no admin,
// it was refused, another admin task is running, or Jellyfin fails.
func (s *Setup) Transcodes(ctx context.Context) (int, error) {
	// Not Lock: a heartbeat must not wait on a long viewer setup.
	if !s.vmu.TryLock() {
		return 0, errors.New("the gateway's admin is busy")
	}
	defer s.vmu.Unlock()
	s.mu.Lock()
	c, refused := s.creds, s.refused
	s.mu.Unlock()
	if c.Password == "" || refused {
		return 0, errors.New("no admin")
	}
	for kept := s.tele != ""; ; kept = false {
		if s.tele == "" {
			tok, err := s.teleSignIn(ctx, c)
			if err != nil {
				return 0, err
			}
			s.tele = tok
		}
		n, err := s.transcodes(ctx, s.tele)
		if !unauthorized(err) || !kept {
			return n, err
		}
		s.tele = "" // revoked (a password change, a reset Jellyfin): sign in once more
	}
}

func (s *Setup) teleSignIn(ctx context.Context, c Creds) (string, error) {
	var auth struct{ AccessToken string }
	body := fmt.Sprintf(`{"Username":%q,"Pw":%q}`, c.User, c.Password)
	err := s.callAs(ctx, 30*time.Second, teleHdr, "POST", "/Users/AuthenticateByName", "", body, &auth)
	if unauthorized(err) { // stop trying: Jellyfin locks users out after failed sign-ins
		s.mu.Lock()
		s.refused = s.creds.Password == c.Password
		s.mu.Unlock()
	}
	if err != nil {
		return "", fmt.Errorf("sign in as %s: %w", c.User, err)
	}
	return auth.AccessToken, nil
}

func (s *Setup) transcodes(ctx context.Context, admin string) (int, error) {
	var ss []struct{ TranscodingInfo *struct{} }
	if err := s.callAs(ctx, 30*time.Second, teleHdr, "GET", "/Sessions", admin, "", &ss); err != nil {
		return 0, err
	}
	n := 0
	for _, x := range ss {
		if x.TranscodingInfo != nil {
			n++
		}
	}
	return n, nil
}
