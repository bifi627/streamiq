package jellyfin

import (
	"context"
	"errors"
)

// Transcodes counts Jellyfin's sessions that transcode now (telemetry), read
// with the gateway's own admin. An error when there's no admin, it was refused,
// another sign-in as it is running, or Jellyfin fails.
// ponytail: signs in and out per call (every 30 s at full); keep the token if that shows in Jellyfin's log.
func (s *Setup) Transcodes(ctx context.Context) (int, error) {
	// Not Lock: a heartbeat must not wait on a long viewer setup. Signing in
	// as the same DeviceId replaces the admin's other token, hence vmu.
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
	admin, err := s.signIn(ctx, c.User, c.Password)
	if unauthorized(err) { // stop trying: Jellyfin locks users out after failed sign-ins
		s.mu.Lock()
		s.refused = s.creds.Password == c.Password
		s.mu.Unlock()
	}
	if err != nil {
		return 0, err
	}
	defer s.logout(ctx, admin)
	var ss []struct{ TranscodingInfo *struct{} }
	if err := s.call(ctx, "GET", "/Sessions", admin, "", &ss); err != nil {
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
