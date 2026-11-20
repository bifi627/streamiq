package tunnel

// Screen relay (docs/protocol.md "Screens"): a TV in screen mode holds
// GET /streamiq/screen open; phones on the same gateway list open screens and
// POST commands, which the gateway writes to that held response as NDJSON lines.
// Opt-in is structural: only a session holding the channel has a screen id, so
// nothing else can be reached. What's watched never leaves the gateway.

import (
	"cmp"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"sync"
)

const (
	ScreenPath  = "/streamiq/screen"
	ScreensPath = "/streamiq/screens"
)

// Session is who sent a tunnel request: the broker session id, the client's
// pairing name (looked up only when a screen opens), and a channel closed when
// the request's data channel closes.
type Session struct {
	ID     string
	User   string // the user's users.id, from the broker's offer: picks their Jellyfin viewer
	Role   string // the user's role in this gateway's household, from the broker's offer: Admin | Member
	Key    string // the client key fp the session authed with (which device)
	Name   func() string
	Route  func() string // relay | lan | direct, decided at call time; nil outside a tunnel
	Closed <-chan struct{}
	Use    *Usage // what the tunnel's requests were for; nil records nothing
}

// ScreenState is the TV's playback state (POST /streamiq/screen/state). Audio /
// Subtitle are Jellyfin stream indexes; null = none chosen.
type ScreenState struct {
	ItemID        string `json:"itemId"`
	PositionTicks int64  `json:"positionTicks"`
	DurationTicks int64  `json:"durationTicks"`
	Paused        bool   `json:"paused"`
	Audio         *int   `json:"audio"`
	Subtitle      *int   `json:"subtitle"`
}

// ScreenCommand is one phone → TV command; the gateway re-encodes it, so only
// these fields reach the TV.
type ScreenCommand struct {
	Type       string `json:"type"` // play | pause | resume | seek | stop | tracks
	ItemID     string `json:"itemId,omitempty"`
	StartTicks *int64 `json:"startTicks,omitempty"`
	Ticks      *int64 `json:"ticks,omitempty"`
	Audio      *int   `json:"audio,omitempty"`
	Subtitle   *int   `json:"subtitle,omitempty"`
}

var itemID = regexp.MustCompile(`^` + id + `$`)

func (c ScreenCommand) valid() bool {
	switch c.Type {
	case "pause", "resume", "stop":
		return c.bare()
	case "play":
		ok := itemID.MatchString(c.ItemID) && atLeast(c.StartTicks, 0)
		c.ItemID, c.StartTicks = "", nil
		return ok && c.bare()
	case "seek":
		ok := c.Ticks != nil && *c.Ticks >= 0
		c.Ticks = nil
		return ok && c.bare()
	case "tracks":
		ok := (c.Audio != nil || c.Subtitle != nil) && atLeast(c.Audio, 0) && atLeast(c.Subtitle, -1)
		c.Audio, c.Subtitle = nil, nil
		return ok && c.bare()
	}
	return false
}

// bare: no field but Type is set. valid clears the fields a type takes, then asks.
func (c ScreenCommand) bare() bool { return c == ScreenCommand{Type: c.Type} }

// atLeast: unset, or set to min or more.
func atLeast[T int | int64](p *T, min T) bool { return p == nil || *p >= min }

// screen is one open screen, held by its GET /streamiq/screen.
type screen struct {
	id, name, session string
	closed, done      <-chan struct{} // the channel's close; the request's end (r.Context())
	cmds              chan []byte     // NDJSON lines, in arrival order (last command wins)

	mu    sync.Mutex
	state *ScreenState
}

// maxQueued: commands a stalled TV may fall behind by; past it the oldest is
// dropped, so the newest still arrives (last command wins). One of them is the
// line serveScreen holds while its write waits, the rest wait in cmds.
const maxQueued = 16

var screens = struct {
	sync.Mutex
	m map[string]*screen
}{m: map[string]*screen{}}

// gone: the channel closed or the request ended; the screen is dead even
// before its handler removes it.
func (s *screen) gone() bool {
	select {
	case <-s.closed:
		return true
	case <-s.done:
		return true
	default:
		return false
	}
}

// screenOf finds the session's open screen; caller holds screens.
func screenOf(session string) *screen {
	for _, s := range screens.m {
		if s.session == session && !s.gone() {
			return s
		}
	}
	return nil
}

// readBody reads a gateway API request body (≤ MaxBody, checked by proxy).
func readBody(r *http.Request) []byte { b, _ := io.ReadAll(r.Body); return b }

// serveScreen holds the TV's screen open: each command is one NDJSON line,
// until the request ends (r.Context(): the channel closed, or the reply can't be
// sent on), which removes the screen.
func serveScreen(w http.ResponseWriter, r *http.Request) {
	who := SessionOf(r)
	if who.ID == "" || who.Closed == nil || who.Name == nil {
		Fail(w, http.StatusNotFound, fmt.Errorf("screen: no session"))
		return
	}
	name := who.Name() // outside the lock: it reads the pairing store
	screens.Lock()
	if screenOf(who.ID) != nil {
		screens.Unlock()
		Fail(w, http.StatusConflict, fmt.Errorf("screen: session %s already holds a screen", who.ID))
		return
	}
	s := &screen{
		id:      rand.Text(),
		name:    name,
		session: who.ID,
		closed:  who.Closed,
		done:    r.Context().Done(),
		cmds:    make(chan []byte, maxQueued-1),
	}
	screens.m[s.id] = s
	screens.Unlock()
	defer func() {
		screens.Lock()
		delete(screens.m, s.id)
		screens.Unlock()
	}()
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	http.NewResponseController(w).Flush()
	for {
		select {
		case line := <-s.cmds:
			if _, err := w.Write(line); err != nil {
				return
			}
			http.NewResponseController(w).Flush()
		case <-s.done:
			return
		}
	}
}

func serveScreenState(w http.ResponseWriter, r *http.Request) {
	who := SessionOf(r)
	screens.Lock()
	s := screenOf(who.ID)
	screens.Unlock()
	if who.ID == "" || s == nil {
		Fail(w, http.StatusNotFound, fmt.Errorf("screen: state from a session without a screen"))
		return
	}
	var st ScreenState
	if json.Unmarshal(readBody(r), &st) != nil || st.PositionTicks < 0 || st.DurationTicks < 0 ||
		(st.ItemID != "" && !itemID.MatchString(st.ItemID)) ||
		(st.Audio != nil && *st.Audio < 0) || (st.Subtitle != nil && *st.Subtitle < -1) {
		Fail(w, http.StatusBadRequest, fmt.Errorf("screen: bad state"))
		return
	}
	s.mu.Lock()
	s.state = &st
	s.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func serveScreens(w http.ResponseWriter, r *http.Request) {
	type item struct {
		ID    string       `json:"id"`
		Name  string       `json:"name"`
		State *ScreenState `json:"state"`
	}
	list := []item{}
	screens.Lock()
	for _, s := range screens.m {
		if !s.gone() {
			s.mu.Lock()
			list = append(list, item{s.id, s.name, s.state})
			s.mu.Unlock()
		}
	}
	screens.Unlock()
	slices.SortFunc(list, func(a, b item) int { return cmp.Or(cmp.Compare(a.Name, b.Name), cmp.Compare(a.ID, b.ID)) })
	JSON(w, http.StatusOK, list)
}

func serveScreenCommand(w http.ResponseWriter, r *http.Request) {
	screens.Lock()
	s := screens.m[r.PathValue("id")]
	screens.Unlock()
	if s == nil || s.gone() {
		Fail(w, http.StatusNotFound, fmt.Errorf("screen: no screen %s", r.URL.Path))
		return
	}
	var c ScreenCommand
	if json.Unmarshal(readBody(r), &c) != nil || !c.valid() {
		Fail(w, http.StatusBadRequest, fmt.Errorf("screen: bad command"))
		return
	}
	line, _ := json.Marshal(c)
	for line = append(line, '\n'); ; {
		select {
		case s.cmds <- line:
		default:
			select { // full: drop the oldest
			case <-s.cmds:
			default:
			}
			continue
		}
		break
	}
	if s.gone() { // closed while we queued
		Fail(w, http.StatusNotFound, fmt.Errorf("screen: screen %s closed", s.id))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
