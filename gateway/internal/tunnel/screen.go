package tunnel

// Screen relay (#95/#179, docs/protocol.md "Screens"): a TV in screen mode holds
// GET /streamiq/screen open; phones on the same gateway list open screens and
// POST commands, which the gateway writes to that held response as NDJSON lines.
// Opt-in is structural: only a session holding the channel has a screen id, so
// nothing else can be reached. What's watched never leaves the gateway.

import (
	"bytes"
	"cmp"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strings"
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
	Name   func() string
	Closed <-chan struct{}
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
		return c.ItemID == "" && c.StartTicks == nil && c.Ticks == nil && c.Audio == nil && c.Subtitle == nil
	case "play":
		return itemID.MatchString(c.ItemID) && (c.StartTicks == nil || *c.StartTicks >= 0) &&
			c.Ticks == nil && c.Audio == nil && c.Subtitle == nil
	case "seek":
		return c.Ticks != nil && *c.Ticks >= 0 && c.ItemID == "" && c.StartTicks == nil && c.Audio == nil && c.Subtitle == nil
	case "tracks":
		return (c.Audio != nil || c.Subtitle != nil) && (c.Audio == nil || *c.Audio >= 0) &&
			(c.Subtitle == nil || *c.Subtitle >= -1) && c.ItemID == "" && c.StartTicks == nil && c.Ticks == nil
	}
	return false
}

// screen is one open screen; it is also the body of its GET /streamiq/screen.
type screen struct {
	id, name, session string
	closed            <-chan struct{}
	cmds              chan []byte // NDJSON lines, in arrival order (last command wins)

	mu    sync.Mutex
	state *ScreenState

	out []byte // rest of the line being read (Read side only)
}

// maxQueued: commands a stalled TV may fall behind by; past it the oldest is
// dropped, so the newest still arrives (last command wins).
const maxQueued = 16

var screens = struct {
	sync.Mutex
	m map[string]*screen
}{m: map[string]*screen{}}

// Read blocks until a command arrives or the data channel closes (io.EOF, then
// Close removes the screen).
func (s *screen) Read(p []byte) (int, error) {
	if len(s.out) == 0 {
		select {
		case s.out = <-s.cmds:
		case <-s.closed:
			return 0, io.EOF
		}
	}
	n := copy(p, s.out)
	s.out = s.out[n:]
	return n, nil
}

func (s *screen) Close() error {
	screens.Lock()
	delete(screens.m, s.id)
	screens.Unlock()
	return nil
}

// gone: the channel closed; the screen is dead even before Close removes it.
func (s *screen) gone() bool {
	select {
	case <-s.closed:
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

// isScreenPath: the screen endpoints' paths (any method; screenAPI 404s the rest).
func isScreenPath(p string) bool {
	return p == ScreenPath || p == ScreenPath+"/state" || p == ScreensPath || strings.HasPrefix(p, ScreensPath+"/")
}

// screenAPI answers the screen endpoints for session who.
func screenAPI(method, p, body string, who Session) (int, map[string]string, io.ReadCloser, error) {
	reply := func(st int, v any) (int, map[string]string, io.ReadCloser, error) {
		if v == nil {
			return st, nil, http.NoBody, nil
		}
		b, _ := json.Marshal(v)
		h := map[string]string{"Content-Type": "application/json", "Content-Length": fmt.Sprint(len(b)), "Cache-Control": "no-store"}
		return st, h, io.NopCloser(bytes.NewReader(b)), nil
	}
	refuse := func(st int, f string, a ...any) (int, map[string]string, io.ReadCloser, error) {
		return st, nil, nil, fmt.Errorf("screen: "+f, a...)
	}
	switch {
	case method == "GET" && p == ScreenPath:
		if who.ID == "" || who.Closed == nil || who.Name == nil {
			return refuse(http.StatusNotFound, "no session")
		}
		name := who.Name() // outside the lock: it reads the pairing store
		screens.Lock()
		defer screens.Unlock()
		if screenOf(who.ID) != nil {
			return refuse(http.StatusConflict, "session %s already holds a screen", who.ID)
		}
		s := &screen{id: rand.Text(), name: name, session: who.ID, closed: who.Closed, cmds: make(chan []byte, maxQueued)}
		screens.m[s.id] = s
		return http.StatusOK, map[string]string{"Content-Type": "application/x-ndjson", "Cache-Control": "no-store"}, s, nil

	case method == "POST" && p == ScreenPath+"/state":
		screens.Lock()
		s := screenOf(who.ID)
		screens.Unlock()
		if who.ID == "" || s == nil {
			return refuse(http.StatusNotFound, "state from a session without a screen")
		}
		var st ScreenState
		if json.Unmarshal([]byte(body), &st) != nil || st.PositionTicks < 0 || st.DurationTicks < 0 ||
			(st.ItemID != "" && !itemID.MatchString(st.ItemID)) ||
			(st.Audio != nil && *st.Audio < 0) || (st.Subtitle != nil && *st.Subtitle < -1) {
			return refuse(http.StatusBadRequest, "bad state")
		}
		s.mu.Lock()
		s.state = &st
		s.mu.Unlock()
		return reply(http.StatusNoContent, nil)

	case method == "GET" && p == ScreensPath:
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
		return reply(http.StatusOK, list)

	case method == "POST" && strings.HasPrefix(p, ScreensPath+"/"):
		screens.Lock()
		s := screens.m[strings.TrimPrefix(p, ScreensPath+"/")]
		screens.Unlock()
		if s == nil || s.gone() {
			return refuse(http.StatusNotFound, "no screen %s", p)
		}
		var c ScreenCommand
		if json.Unmarshal([]byte(body), &c) != nil || !c.valid() {
			return refuse(http.StatusBadRequest, "bad command")
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
			return refuse(http.StatusNotFound, "screen %s closed", s.id)
		}
		return reply(http.StatusNoContent, nil)
	}
	return refuse(http.StatusNotFound, "no %s %s", method, p)
}
