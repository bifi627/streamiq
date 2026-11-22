package pairing

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"slices"
	"strings"

	"streamiq/gateway/internal/tunnel"
)

// Gateway API (docs/protocol.md): ClientsPath lists the paired clients: GET →
// [{keyFp, name, addedAt, self}], self = the calling session's client key.
// ClientsRemovePath removes one: POST {"keyFp": "…"} → 200 {}, unknown → 404. The
// allowlist lives on the gateway only. A member sees and removes only its own
// client key: any other key → 403. ClientsRenamePath renames one:
// POST {"keyFp", "name"} → 200 {"name": stored}, same access and 404 as remove, a
// bad name 400. ClientsProfilePath stores the calling session's own capability
// probe: POST ProfileIn → 200 {}, a bad body 400.
const (
	ClientsPath        = "/streamiq/clients"
	ClientsRemovePath  = "/streamiq/clients/remove"
	ClientsRenamePath  = "/streamiq/clients/rename"
	ClientsProfilePath = "/streamiq/clients/profile"
)

// ServeClients is GET ClientsPath.
func (s *Store) ServeClients(w http.ResponseWriter, r *http.Request) {
	who := tunnel.SessionOf(r)
	out := []Client{}
	for _, p := range s.Paired() {
		if self := p.KeyFp == who.Key; self || who.Role == tunnel.Admin {
			out = append(out, Client{p.KeyFp, p.Name, p.AddedAt, self, p.Profile})
		}
	}
	tunnel.JSON(w, http.StatusOK, out)
}

// keyIn reads {"keyFp", "name"} and checks the caller may touch that key: a
// member only its own, refused before the lookup so it learns nothing about
// other keys. ok = false: the request is answered.
func keyIn(w http.ResponseWriter, r *http.Request, what string) (keyFp, name string, ok bool) {
	var in ClientKey
	b, _ := io.ReadAll(r.Body)
	if json.Unmarshal(b, &in) != nil || in.KeyFp == "" {
		tunnel.Fail(w, http.StatusBadRequest, fmt.Errorf("gateway API: %s client: bad body", what))
		return "", "", false
	}
	if who := tunnel.SessionOf(r); in.KeyFp != who.Key && who.Role != tunnel.Admin {
		tunnel.Fail(
			w,
			http.StatusForbidden,
			fmt.Errorf("gateway API: %s client: a member may only touch its own", what),
		)
		return "", "", false
	}
	return in.KeyFp, in.Name, true
}

// ServeRemove is POST ClientsRemovePath: another client goes at once (its
// sessions closed, a failed save is 500). The calling client itself goes only
// after the reply is delivered (tunnel.AfterReply): its removal closes this very
// session, which would swallow the reply. A failed save is then only logged (the
// in-memory allowlist refuses it anyway).
func (s *Store) ServeRemove(w http.ResponseWriter, r *http.Request) {
	fp, _, ok := keyIn(w, r, "remove")
	if !ok {
		return
	}
	if !s.Allowed(fp) {
		tunnel.Fail(w, http.StatusNotFound, errors.New("gateway API: remove client: not paired"))
		return
	}
	if fp != tunnel.SessionOf(r).Key {
		if err := s.Remove(fp); err != nil {
			tunnel.Fail(w, http.StatusInternalServerError, fmt.Errorf("gateway API: remove client: %w", err))
			return
		}
	} else {
		tunnel.AfterReply(r, func() {
			if err := s.Remove(fp); err != nil {
				log.Printf("gateway: remove client: %v", err)
			}
		})
	}
	tunnel.JSON(w, http.StatusOK, struct{}{})
}

// ServeRename is POST ClientsRenamePath.
func (s *Store) ServeRename(w http.ResponseWriter, r *http.Request) {
	fp, name, ok := keyIn(w, r, "rename")
	if !ok {
		return
	}
	n, err := s.Rename(fp, name)
	switch {
	case errors.Is(err, ErrNotPaired):
		tunnel.Fail(w, http.StatusNotFound, fmt.Errorf("gateway API: rename client: %w", err))
	case errors.Is(err, ErrBadName):
		tunnel.Fail(w, http.StatusBadRequest, fmt.Errorf("gateway API: rename client: %w", err))
	case err != nil:
		tunnel.Fail(w, http.StatusInternalServerError, fmt.Errorf("gateway API: rename client: %w", err))
	default:
		tunnel.JSON(w, http.StatusOK, ClientName{n})
	}
}

// maxProfile caps the body: a probe is a few hundred bytes, and it lands in
// allowlist.json.
const maxProfile = 4 << 10

// ServeProfile is POST ClientsProfilePath. The body names no key: a client
// writes only its own profile.
func (s *Store) ServeProfile(w http.ResponseWriter, r *http.Request) {
	var in ProfileIn
	dec := json.NewDecoder(io.LimitReader(r.Body, maxProfile+1))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil || dec.More() || !in.Probe.valid() {
		tunnel.Fail(w, http.StatusBadRequest, errors.New("gateway API: client profile: bad body"))
		return
	}
	err := s.SetProfile(tunnel.SessionOf(r).Key, in)
	switch {
	case errors.Is(err, ErrNotPaired):
		tunnel.Fail(w, http.StatusNotFound, fmt.Errorf("gateway API: client profile: %w", err))
	case err != nil:
		tunnel.Fail(w, http.StatusInternalServerError, fmt.Errorf("gateway API: client profile: %w", err))
	default:
		tunnel.JSON(w, http.StatusOK, struct{}{})
	}
}

// valid keeps stored names short and plain: codec and profile names are
// lowercase words ("constrained baseline"), levels Jellyfin units.
func (p Probe) valid() bool {
	names := func(xs []string) bool {
		return xs != nil && len(xs) <= 8 && !slices.ContainsFunc(xs, func(x string) bool {
			return len(x) == 0 || len(x) > 24 || strings.Trim(x, "abcdefghijklmnopqrstuvwxyz0123456789 ") != ""
		})
	}
	level := func(l int) bool { return l >= 0 && l <= 1000 }
	return names(p.Audio) &&
		(p.H264 == nil || names(p.H264.Profiles) && level(p.H264.Level)) &&
		(p.Hevc == nil || level(p.Hevc.Level))
}
