package tunnel

// Screen relay (#95/#179, docs/protocol.md "Screens"): a TV in screen mode holds
// GET /streamiq/screen open; phones on the same gateway list open screens and
// POST commands, which the gateway writes to that held response as NDJSON lines.
// Opt-in is structural: only a session holding the channel has a screen id, so
// nothing else can be reached. What's watched never leaves the gateway.

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
)

const (
	ScreenPath  = "/streamiq/screen"
	ScreensPath = "/streamiq/screens"
)

// Session is who sent a tunnel request: the broker session id, the client's
// pairing name, and a channel closed when the request's data channel closes.
type Session struct {
	ID, Name string
	Closed   <-chan struct{}
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
		return (c.Audio != nil || c.Subtitle != nil) && c.ItemID == "" && c.StartTicks == nil && c.Ticks == nil
	}
	return false
}

// screen is one open screen; it is also the body of its GET /streamiq/screen.
type screen struct {
	id, name, session string
	closed            <-chan struct{}
	wake              chan struct{} // cap 1: a command is waiting in next

	mu    sync.Mutex
	state *ScreenState
	next  []byte // the undelivered command; a newer one replaces it (last command wins)

	out []byte // rest of the line being read (Read side only)
}

var screens = struct {
	sync.Mutex
	m map[string]*screen
}{m: map[string]*screen{}}

// Read blocks until a command arrives or the data channel closes (io.EOF, then
// Close removes the screen).
func (s *screen) Read(p []byte) (int, error) {
	for len(s.out) == 0 {
		s.mu.Lock()
		s.out, s.next = s.next, nil
		s.mu.Unlock()
		if len(s.out) > 0 {
			break
		}
		select {
		case <-s.wake:
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

func (s *screen) send(line []byte) {
	s.mu.Lock()
	s.next = line
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// screenOf finds the session's own screen.
func screenOf(session string) *screen {
	screens.Lock()
	defer screens.Unlock()
	for _, s := range screens.m {
		if s.session == session {
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
		return st, h, io.NopCloser(strings.NewReader(string(b))), nil
	}
	refuse := func(st int, f string, a ...any) (int, map[string]string, io.ReadCloser, error) {
		return st, nil, nil, fmt.Errorf("screen: "+f, a...)
	}
	switch {
	case method == "GET" && p == ScreenPath:
		if who.ID == "" || who.Closed == nil {
			return refuse(http.StatusNotFound, "no session")
		}
		if screenOf(who.ID) != nil {
			return refuse(http.StatusConflict, "session %s already holds a screen", who.ID)
		}
		s := &screen{id: rand.Text(), name: who.Name, session: who.ID, closed: who.Closed, wake: make(chan struct{}, 1)}
		screens.Lock()
		screens.m[s.id] = s
		screens.Unlock()
		return http.StatusOK, map[string]string{"Content-Type": "application/x-ndjson", "Cache-Control": "no-store"}, s, nil

	case method == "POST" && p == ScreenPath+"/state":
		s := screenOf(who.ID)
		if who.ID == "" || s == nil {
			return refuse(http.StatusNotFound, "state from a session without a screen")
		}
		var st ScreenState
		if json.Unmarshal([]byte(body), &st) != nil || st.PositionTicks < 0 || st.DurationTicks < 0 ||
			(st.ItemID != "" && !itemID.MatchString(st.ItemID)) {
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
			s.mu.Lock()
			list = append(list, item{s.id, s.name, s.state})
			s.mu.Unlock()
		}
		screens.Unlock()
		return reply(http.StatusOK, list)

	case method == "POST" && strings.HasPrefix(p, ScreensPath+"/"):
		screens.Lock()
		s := screens.m[strings.TrimPrefix(p, ScreensPath+"/")]
		screens.Unlock()
		if s == nil {
			return refuse(http.StatusNotFound, "no screen %s", p)
		}
		var c ScreenCommand
		if json.Unmarshal([]byte(body), &c) != nil || !c.valid() {
			return refuse(http.StatusBadRequest, "bad command")
		}
		line, _ := json.Marshal(c)
		s.send(append(line, '\n'))
		return reply(http.StatusNoContent, nil)
	}
	return refuse(http.StatusNotFound, "no %s %s", method, p)
}
