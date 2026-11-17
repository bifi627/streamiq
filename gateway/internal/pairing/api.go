package pairing

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"

	"streamiq/gateway/internal/tunnel"
)

// Gateway API (docs/protocol.md): ClientsPath lists the paired clients (#311): GET →
// [{keyFp, name, addedAt, self}], self = the calling session's client key.
// ClientsRemovePath removes one: POST {"keyFp": "…"} → 200 {}, unknown → 404. The
// allowlist lives on the gateway only. A member sees and removes only its own
// client key (#341): any other key → 403. ClientsRenamePath renames one (#365):
// POST {"keyFp", "name"} → 200 {"name": stored}, same access and 404 as remove, a
// bad name 400.
const (
	ClientsPath       = "/streamiq/clients"
	ClientsRemovePath = "/streamiq/clients/remove"
	ClientsRenamePath = "/streamiq/clients/rename"
)

// ServeClients is GET ClientsPath.
func (s *Store) ServeClients(w http.ResponseWriter, r *http.Request) {
	who := tunnel.SessionOf(r)
	type client struct {
		Paired
		Self bool `json:"self"`
	}
	out := []client{}
	for _, p := range s.Paired() {
		if self := p.KeyFp == who.Key; self || who.Role == tunnel.Admin {
			out = append(out, client{p, self})
		}
	}
	tunnel.JSON(w, http.StatusOK, out)
}

// keyIn reads {"keyFp", "name"} and checks the caller may touch that key: a
// member only its own, refused before the lookup so it learns nothing about
// other keys. ok = false: the request is answered.
func keyIn(w http.ResponseWriter, r *http.Request, what string) (keyFp, name string, ok bool) {
	var in struct{ KeyFp, Name string }
	b, _ := io.ReadAll(r.Body)
	if json.Unmarshal(b, &in) != nil || in.KeyFp == "" {
		tunnel.Fail(w, http.StatusBadRequest, fmt.Errorf("gateway API: %s client: bad body", what))
		return "", "", false
	}
	if who := tunnel.SessionOf(r); in.KeyFp != who.Key && who.Role != tunnel.Admin {
		tunnel.Fail(w, http.StatusForbidden, fmt.Errorf("gateway API: %s client: a member may only touch its own", what))
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
		tunnel.JSON(w, http.StatusOK, map[string]string{"name": n})
	}
}
