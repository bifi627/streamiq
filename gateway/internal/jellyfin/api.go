package jellyfin

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"

	"streamiq/gateway/internal/tunnel"
)

// Gateway API (docs/protocol.md), admin-only: a managed Jellyfin's libraries.
// LibrariesPath lists them: GET → [Library]. The POSTs answer 200 {}:
// LibrariesOnlinePath {id, on} sets its fetchers, LibrariesExtrasPath
// {id, on} its extras, LibrariesRescanPath {id} starts a scan. A bad body is
// 400; a Jellyfin the gateway didn't set up 409; a Jellyfin failure 502 with
// LibraryError (Jellyfin's message).
const (
	LibrariesPath       = "/streamiq/libraries"
	LibrariesOnlinePath = "/streamiq/libraries/online"
	LibrariesExtrasPath = "/streamiq/libraries/extras"
	LibrariesRescanPath = "/streamiq/libraries/rescan"
)

// ServeLibraries is GET LibrariesPath.
func (s *Setup) ServeLibraries(w http.ResponseWriter, r *http.Request) {
	libs, err := s.Libraries(r.Context())
	if err != nil {
		libFail(w, "list", err)
		return
	}
	if libs == nil {
		libs = []Library{}
	}
	tunnel.JSON(w, http.StatusOK, libs)
}

// ServeOnline is POST LibrariesOnlinePath.
func (s *Setup) ServeOnline(w http.ResponseWriter, r *http.Request) {
	if in, ok := libIn(w, r, "online"); ok {
		libReply(w, "online", s.SetOnline(r.Context(), in.ID, in.On))
	}
}

// ServeExtras is POST LibrariesExtrasPath.
func (s *Setup) ServeExtras(w http.ResponseWriter, r *http.Request) {
	if in, ok := libIn(w, r, "extras"); ok {
		libReply(w, "extras", s.SetExtras(r.Context(), in.ID, in.On))
	}
}

// ServeRescan is POST LibrariesRescanPath.
func (s *Setup) ServeRescan(w http.ResponseWriter, r *http.Request) {
	if in, ok := libIn(w, r, "rescan"); ok {
		libReply(w, "rescan", s.Rescan(r.Context(), in.ID))
	}
}

// libIn reads a body with an id (LibrarySwitch: LibraryID plus on); ok = false:
// answered 400.
func libIn(w http.ResponseWriter, r *http.Request, what string) (in LibrarySwitch, ok bool) {
	b, _ := io.ReadAll(io.LimitReader(r.Body, 4<<10))
	if json.Unmarshal(b, &in) != nil || in.ID == "" {
		tunnel.Fail(w, http.StatusBadRequest, fmt.Errorf("gateway API: library %s: bad body", what))
		return in, false
	}
	return in, true
}

func libReply(w http.ResponseWriter, what string, err error) {
	if err != nil {
		libFail(w, what, err)
		return
	}
	tunnel.JSON(w, http.StatusOK, struct{}{})
}

// libFail: 409 for a Jellyfin the user brought (the web app says so, never a
// 404: that's a gateway without these endpoints), else Jellyfin's error as 502.
func libFail(w http.ResponseWriter, what string, err error) {
	if errors.Is(err, errUserJellyfin) {
		tunnel.Fail(w, http.StatusConflict, fmt.Errorf("gateway API: library %s: %w", what, err))
		return
	}
	log.Printf("gateway: tunnel: gateway API: library %s: %v", what, err)
	tunnel.JSON(w, http.StatusBadGateway, LibraryError{err.Error()})
}
