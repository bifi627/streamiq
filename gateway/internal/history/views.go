package history

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"time"

	"streamiq/gateway/internal/tunnel"
)

// ViewDays: how long the watch history is kept; ViewLimit caps GET /streamiq/views.
// ponytail: newest ViewLimit, no paging; page with ?before= if a year outgrows it.
const (
	ViewDays  = 365
	ViewLimit = 500
)

// A Jellyfin item id, as the Jellyfin policy reads one.
var itemID = regexp.MustCompile(`^` + tunnel.JellyfinID + `$`)

// Views is the watch history: one line per playback, kept per user.
type Views struct{ Store *Store }

// ServeAdd is POST /streamiq/views: records a view of itemId by the session's user, now.
func (v *Views) ServeAdd(w http.ResponseWriter, r *http.Request) {
	user := tunnel.SessionOf(r).User
	if user == "" {
		tunnel.Fail(w, http.StatusForbidden, errors.New("views: no user on this session"))
		return
	}
	var b AddView
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&b) != nil || !itemID.MatchString(b.ItemID) {
		tunnel.Fail(w, http.StatusBadRequest, errors.New("views: bad body"))
		return
	}
	now := time.Now().UTC()
	if err := v.Store.Append(now, View{ItemID: b.ItemID, At: now, UserID: user}); err != nil {
		tunnel.Fail(w, http.StatusInternalServerError, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ServeList is GET /streamiq/views: the session user's own views, newest first, at most
// ViewLimit. Who asks comes from the session, never the request.
func (v *Views) ServeList(w http.ResponseWriter, r *http.Request) {
	user := tunnel.SessionOf(r).User
	rows, err := Read[View](v.Store)
	if err != nil {
		tunnel.Fail(w, http.StatusInternalServerError, err)
		return
	}
	out := []View{}
	for _, l := range slices.Backward(rows) {
		if len(out) == ViewLimit {
			break
		}
		if user != "" && l.UserID == user {
			l.UserID = ""
			out = append(out, l)
		}
	}
	tunnel.JSON(w, http.StatusOK, out)
}
