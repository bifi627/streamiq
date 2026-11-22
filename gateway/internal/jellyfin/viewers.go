// The hidden viewer users: the gateway's own and one per StreamIQ user, and their token repair.

package jellyfin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"regexp"
	"strings"
)

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
		if err := s.call(
			ctx,
			"POST",
			"/Users/"+u.Id+"/Password",
			admin,
			fmt.Sprintf(`{"NewPw":%q}`, pw),
			nil,
		); err != nil {
			return "", "", err
		}
	} else {
		u = &user{}
		if err := s.call(
			ctx,
			"POST",
			"/Users/New",
			admin,
			fmt.Sprintf(`{"Name":%q,"Password":%q}`, name, pw),
			u,
		); err != nil {
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

// check repairs revoked viewer tokens by signing in again with the stored
// viewer passwords. If Jellyfin refuses the shared viewer's too, its token is
// dropped and the page asks for an admin login; a refused user's viewer is
// dropped and made again on their next session. Its error stays on the page
// until a check goes through.
func (s *Setup) check(ctx context.Context) {
	s.vmu.Lock()
	defer s.vmu.Unlock()
	failed := false
	fail := func(err error) {
		failed = true
		s.setErr(checkErr + err.Error())
	}
	defer func() {
		if !failed && strings.HasPrefix(s.View().Err, checkErr) {
			s.setErr("")
		}
	}()
	s.mu.Lock()
	c := s.creds
	s.mu.Unlock()
	tok := ""
	if c.Token != "" { // dropped: only a page login brings it back
		var err error
		if tok, err = s.renew(ctx, c.Token, c.Viewer, c.ViewerPassword); err != nil {
			fail(err) // transient: retried next poll
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
			fail(err)
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
		fail(err)
	}
}

// checkErr starts check's errors, so a later check clears only its own.
const checkErr = "Jellyfin token check: "

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

// EnsureViewer gives a StreamIQ user their own viewer on their first session;
// later sessions find it. If that fails, the session plays as the
// shared viewer, the log and the page say why, and the next session tries again.
func (s *Setup) EnsureViewer(ctx context.Context, user string) {
	user = strings.ToLower(user)
	if tok, _ := s.ViewerFor(user); tok != "" {
		return // the common case, without waiting for vmu
	}
	s.vmu.Lock() // also: two sessions of a new user at once make one viewer
	defer s.vmu.Unlock()
	s.mu.Lock()
	c, refused := s.creds, s.refused
	s.mu.Unlock()
	if _, ok := c.Users[user]; ok || refused {
		return
	}
	v, refused, err := s.newViewer(ctx, c, user)
	if err != nil {
		fix := "the next session tries again"
		switch {
		case refused && c.managed():
			fix = "changed the " + c.User + " password? Sign in as " + c.User + " with the new one on the local gateway page, or put it in " + s.path() + " (password)"
		case refused:
			fix = "reconnect Jellyfin"
		}
		s.mu.Lock()
		s.err = "Jellyfin user for a member (they play as " + ViewerName + " meanwhile; " + fix + "): " + err.Error()
		s.refused = refused
		s.mu.Unlock()
		slog.Error(
			"gateway: could not create a user's own Jellyfin viewer; the session plays as "+ViewerName,
			"user",
			user,
			"err",
			err,
		)
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

// newViewer: refused = Jellyfin refused the gateway's admin sign-in.
func (s *Setup) newViewer(ctx context.Context, c Creds, user string) (v Viewer, refused bool, err error) {
	if !userID.MatchString(user) {
		return Viewer{}, false, fmt.Errorf("bad user id %q", user)
	}
	if c.Password == "" {
		return Viewer{}, false, errors.New("the gateway has no Jellyfin administrator of its own")
	}
	admin, err := s.signIn(ctx, c.User, c.Password)
	if err != nil {
		return Viewer{}, unauthorized(err), err
	}
	defer s.logout(ctx, admin)
	v, err = s.makeViewer(ctx, admin, "streamiq-"+user)
	return v, false, err
}

// ViewerFor is a user's own viewer token and Jellyfin user id; "" if they have
// none (yet), so the tunnel uses the shared viewer.
func (s *Setup) ViewerFor(user string) (token, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := s.creds.Users[strings.ToLower(user)]
	return v.Token, v.ID
}

// ViewerState is GET /streamiq/status's "viewer" for a session of user:
// whether it plays as the shared viewer and, if so, why, as a code the web app
// words. No credentials, no Jellyfin ids.
func (s *Setup) ViewerState(user string) ViewerStatus {
	if tok, id := s.ViewerFor(user); tok != "" && id != "" {
		return ViewerStatus{Shared: false}
	}
	s.mu.Lock()
	refused, admin := s.refused, s.creds.Password != ""
	s.mu.Unlock()
	reason := "failed" // retried on the user's next session
	switch {
	case refused:
		reason = "admin-refused"
	case !admin:
		reason = "no-admin"
	}
	return ViewerStatus{Shared: true, Reason: reason}
}
