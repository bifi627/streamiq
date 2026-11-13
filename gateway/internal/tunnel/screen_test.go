package tunnel

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func call(t *testing.T, method, url, body string, who Session) (int, io.ReadCloser) {
	t.Helper()
	raw, _ := json.Marshal(tunnelReq{Method: method, URL: url, Body: body})
	status, _, rc, _ := proxy(&Jellyfin{}, raw, who) // screens never touch Jellyfin
	return status, rc
}

func list(t *testing.T) []struct {
	ID, Name string
	State    *ScreenState
} {
	t.Helper()
	status, rc := call(t, "GET", ScreensPath, "", Session{ID: "phone"})
	if status != 200 {
		t.Fatalf("list: %d", status)
	}
	var out []struct {
		ID, Name string
		State    *ScreenState
	}
	if err := json.NewDecoder(rc).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

// next reads one NDJSON command from a screen's stream, or "" on timeout / EOF.
func next(r *bufio.Reader) string {
	got := make(chan string, 1)
	go func() { l, _ := r.ReadString('\n'); got <- strings.TrimSpace(l) }()
	select {
	case l := <-got:
		return l
	case <-time.After(2 * time.Second):
		return ""
	}
}

// A TV opens a screen, a phone sees it, sends commands (last one wins), reads
// its state; the screen is gone the moment its channel closes.
func TestScreenRelay(t *testing.T) {
	closed := make(chan struct{})
	tv := Session{ID: "tv", Name: func() string { return "Living room TV" }, Closed: closed}
	status, body := call(t, "GET", ScreenPath, "", tv)
	if status != 200 {
		t.Fatalf("open screen: %d", status)
	}
	t.Cleanup(func() { body.Close() })
	stream := bufio.NewReader(body)

	l := list(t)
	if len(l) != 1 || l[0].Name != "Living room TV" || l[0].State != nil || l[0].ID == "tv" {
		t.Fatalf("screens = %+v", l)
	}
	sid := l[0].ID

	if s, _ := call(t, "POST", ScreenPath+"/state", `{"itemId":"`+vid+`","positionTicks":5,"durationTicks":9,"paused":true,"audio":1,"subtitle":null}`, tv); s != 204 {
		t.Fatalf("state: %d", s)
	}
	if st := list(t)[0].State; st == nil || st.ItemID != vid || st.PositionTicks != 5 || !st.Paused || *st.Audio != 1 || st.Subtitle != nil {
		t.Fatalf("state = %+v", st)
	}

	phone := Session{ID: "phone"}
	if s, _ := call(t, "POST", ScreensPath+"/"+sid, `{"type":"play","itemId":"`+vid+`","startTicks":0,"extra":1}`, phone); s != 204 {
		t.Fatalf("play: %d", s)
	}
	if got := next(stream); got != `{"type":"play","itemId":"`+vid+`","startTicks":0}` {
		t.Fatalf("play line = %q", got)
	}
	// Two phones, nothing read in between: both arrive in order, so the last one wins.
	call(t, "POST", ScreensPath+"/"+sid, `{"type":"pause"}`, phone)
	call(t, "POST", ScreensPath+"/"+sid, `{"type":"seek","ticks":42}`, Session{ID: "phone2"})
	if a, b := next(stream), next(stream); a != `{"type":"pause"}` || b != `{"type":"seek","ticks":42}` {
		t.Fatalf("commands = %q, %q", a, b)
	}

	close(closed) // the TV's channel closes: gone at once, before handleReq gets to Close
	if l := list(t); len(l) != 0 {
		t.Fatalf("screen outlived its channel: %+v", l)
	}
	if s, _ := call(t, "POST", ScreensPath+"/"+sid, `{"type":"stop"}`, phone); s != 404 {
		t.Fatalf("command to closed screen: %d", s)
	}
	tv.Closed = make(chan struct{}) // same session reopens on a new channel: no 409
	if s, rc := call(t, "GET", ScreenPath, "", tv); s != 200 {
		t.Fatalf("reopen: %d", s)
	} else {
		defer rc.Close()
	}
	if _, err := body.Read(make([]byte, 1)); err != io.EOF {
		t.Fatalf("stream after close: %v", err)
	}
	body.Close() // handleReq's defer
	if l := list(t); len(l) != 1 || l[0].ID == sid {
		t.Fatalf("screens after reopen = %+v", l)
	}
}

func TestScreenRefusals(t *testing.T) {
	closed := make(chan struct{})
	defer close(closed)
	tv := Session{ID: "tv", Name: func() string { return "TV" }, Closed: closed}
	status, body := call(t, "GET", ScreenPath, "", tv)
	if status != 200 {
		t.Fatalf("open screen: %d", status)
	}
	defer body.Close()
	sid := list(t)[0].ID
	laptop := Session{ID: "laptop", Closed: make(chan struct{})} // watching, never opened a screen

	for _, c := range []struct {
		method, url, body string
		who               Session
		want              int
	}{
		// Opt-in: a session that never opened a screen can't be reached.
		{"POST", ScreensPath + "/laptop", `{"type":"pause"}`, tv, 404},
		{"POST", ScreensPath + "/" + sid + "x", `{"type":"pause"}`, laptop, 404},
		{"POST", ScreenPath + "/state", `{"paused":true}`, laptop, 404},
		{"GET", ScreenPath, "", Session{}, 404},
		{"GET", ScreenPath, "", tv, 409},
		{"GET", ScreensPath + "/" + sid, "", laptop, 404},
		{"POST", ScreensPath, `{"type":"pause"}`, laptop, 404},
		{"POST", ScreensPath + "/" + sid, `{"type":"jump"}`, laptop, 400},
		{"POST", ScreensPath + "/" + sid, `not json`, laptop, 400},
		{"POST", ScreensPath + "/" + sid, `{"type":"play","itemId":"../x"}`, laptop, 400},
		{"POST", ScreensPath + "/" + sid, `{"type":"seek"}`, laptop, 400},
		{"POST", ScreensPath + "/" + sid, `{"type":"seek","ticks":-1}`, laptop, 400},
		{"POST", ScreensPath + "/" + sid, `{"type":"tracks"}`, laptop, 400},
		{"POST", ScreensPath + "/" + sid, `{"type":"tracks","audio":-1}`, laptop, 400},
		{"POST", ScreensPath + "/" + sid, `{"type":"tracks","subtitle":-2}`, laptop, 400},
		{"POST", ScreensPath + "/" + sid, `{"type":"seek","ticks":1.5}`, laptop, 400},
		{"POST", ScreensPath + "/" + sid, `{"type":"pause","ticks":1}`, laptop, 400},
		{"POST", ScreenPath + "/state", `{"positionTicks":-1}`, tv, 400},
		{"POST", ScreenPath + "/state", `{"subtitle":-2}`, tv, 400},
		{"POST", ScreensPath + "/" + sid, `{"type":"pause","x":"` + strings.Repeat("x", MaxBody) + `"}`, laptop, http.StatusRequestEntityTooLarge},
	} {
		if s, _ := call(t, c.method, c.url, c.body, c.who); s != c.want {
			t.Errorf("%s %s %.40s: %d, want %d", c.method, c.url, c.body, s, c.want)
		}
	}
	if s, _ := call(t, "POST", ScreensPath+"/"+sid, `{"type":"tracks","subtitle":-1}`, laptop); s != 204 {
		t.Errorf("tracks: %d", s)
	}
	for range maxQueued { // the TV isn't reading: the queue fills and drops the oldest
		call(t, "POST", ScreensPath+"/"+sid, `{"type":"pause"}`, laptop)
	}
	if s, _ := call(t, "POST", ScreensPath+"/"+sid, `{"type":"stop"}`, laptop); s != 204 {
		t.Errorf("full queue: %d", s)
	}
	stream := bufio.NewReader(body)
	var last string
	for range maxQueued {
		last = next(stream)
	}
	if last != `{"type":"stop"}` {
		t.Errorf("newest command after a full queue = %q", last)
	}
}
