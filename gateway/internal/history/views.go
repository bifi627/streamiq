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

// ViewLimit caps GET /streamiq/views without itemId; the watch history is kept forever.
// ponytail: newest ViewLimit, no paging; page with ?before= if the page needs more.
const ViewLimit = 500

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

// ServeList is GET /streamiq/views[?itemId=]: the session user's own views, newest
// first: of that item all of them (the view count), else the newest ViewLimit. Who asks
// comes from the session, never the request.
// ponytail: reads every day file per call; an index if years of views make it slow.
func (v *Views) ServeList(w http.ResponseWriter, r *http.Request) {
	user := tunnel.SessionOf(r).User
	item, one := r.URL.Query()["itemId"]
	if one && (len(item) != 1 || !itemID.MatchString(item[0])) {
		tunnel.Fail(w, http.StatusBadRequest, errors.New("views: bad itemId"))
		return
	}
	rows, err := Read[View](v.Store)
	if err != nil {
		tunnel.Fail(w, http.StatusInternalServerError, err)
		return
	}
	out := []View{}
	for _, l := range slices.Backward(rows) {
		if !one && len(out) == ViewLimit {
			break
		}
		if user != "" && l.UserID == user && (!one || l.ItemID == item[0]) {
			l.UserID = ""
			out = append(out, l)
		}
	}
	tunnel.JSON(w, http.StatusOK, out)
}
