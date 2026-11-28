package tunnel

import (
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestUsage(t *testing.T) {
	const video = "/videos/0123456789abcdef0123456789abcdef/main.m3u8"
	t0 := time.Now()
	cases := []struct {
		name string
		reqs [][2]string // method, path
		want string
	}{
		{"playback", [][2]string{{"GET", video}}, "playback"},
		{"browsing", [][2]string{{"GET", "/Items"}}, "browsing"},
		{"a POST under /Videos is browsing", [][2]string{{"POST", video}}, "browsing"},
		{"diagnostics", [][2]string{{"GET", "/streamiq/burst"}}, "diagnostics"},
		{"diagnostics, any spelling", [][2]string{{"GET", "/StreamIQ/Burst"}}, "diagnostics"},
		{"management", [][2]string{{"POST", "/streamiq/name"}}, "management"},
		{"the highest rank wins, in any order", [][2]string{
			{"GET", "/streamiq/status"}, {"GET", video}, {"GET", "/Items"}, {"GET", "/streamiq/burst"},
		}, "playback"},
		{"browsing over diagnostics and management", [][2]string{
			{"GET", "/streamiq/burst"}, {"GET", "/UserViews"}, {"GET", "/streamiq/route"},
		}, "browsing"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			u := NewUsage(t0)
			for i, r := range c.reqs {
				u.record(r[0], r[1], t0.Add(time.Duration(i+1)*time.Second))
			}
			use, ms := u.Summary()
			if want := int64(len(c.reqs)) * 1000; use != c.want || ms == nil || *ms != want {
				t.Fatalf("got %q %v, want %q %d", use, ms, c.want, want)
			}
		})
	}
}

func TestUsageNone(t *testing.T) {
	if use, ms := NewUsage(time.Now()).Summary(); use != "" || ms != nil {
		t.Fatalf("got %q %v, want none", use, ms)
	}
	var u *Usage
	u.record("GET", "/Items", time.Now()) // a test session: no panic
}

// The last request to end decides activeMs, not the last one recorded.
func TestUsageActiveIsTheLatestEnd(t *testing.T) {
	t0 := time.Now()
	u := NewUsage(t0)
	u.record("GET", "/Items", t0.Add(5*time.Second))
	u.record("GET", "/Items", t0.Add(2*time.Second))
	if _, ms := u.Summary(); ms == nil || *ms != 5000 {
		t.Fatalf("activeMs %d, want 5000", *ms)
	}
}

// The throughput report is kept, and counts as neither use nor active time.
func TestThroughputIsNoUse(t *testing.T) {
	for body, want := range map[string]int{`{"throughputKbps":4200}`: 4200, `{"throughputKbps":-1}`: 0, `{}`: 0} {
		u := NewUsage(time.Now())
		u.SetThroughput(1) // the last report wins, also one without a measurement
		s, _, _, _ := Do(NewRouter(), Session{Use: u}, "POST", ThroughputPath, body)
		if use, ms := u.Summary(); s != 204 || u.Throughput() != want || use != "" || ms != nil {
			t.Errorf("%s: %d, kept %d, use %q %v; want 204, %d, none", body, s, u.Throughput(), use, ms, want)
		}
	}
	if s, _, _, _ := Do(NewRouter(), Session{}, "POST", ThroughputPath, "nope"); s != 400 {
		t.Fatalf("a bad body: %d", s)
	}
}

// serve records each request it ran on the tunnel's Usage.
func TestServeRecordsUsage(t *testing.T) {
	u := NewUsage(time.Now())
	raw := []byte(`{"method":"GET","url":"/streamiq/route"}`)
	serve(httptest.NewRecorder(), &Root{}, raw, &reqState{who: Session{Use: u}})
	if use, ms := u.Summary(); use != "management" || ms == nil {
		t.Fatalf("got %q %v, want management", use, ms)
	}
}

// A playback summary is kept on the tunnel, the latest PlaybackCap only, and counts
// as neither use nor active time.
func TestPlaybacksAreKeptCapped(t *testing.T) {
	u := NewUsage(time.Now())
	for i := range PlaybackCap + 2 {
		body := fmt.Sprintf(`{"itemId":"%032d","codec":"hevc","playedSec":60}`, i)
		if s, _, _, _ := Do(NewRouter(), Session{Use: u}, "POST", PlaybackPath, body); s != 204 {
			t.Fatalf("status %d, want 204", s)
		}
	}
	got := u.Playbacks()
	last := Playback{ItemID: fmt.Sprintf("%032d", 21), Codec: "hevc", PlayedSec: 60}
	if len(got) != PlaybackCap || got[0].ItemID != fmt.Sprintf("%032d", 2) || got[PlaybackCap-1] != last {
		t.Fatalf("kept %d from %+v to %+v, want items 2 … 21", len(got), got[0], got[len(got)-1])
	}
	if use, ms := u.Summary(); use != "" || ms != nil {
		t.Fatalf("use %q %v, want none", use, ms)
	}
	id := `"itemId":"` + strings.Repeat("a", 32) + `"`
	long := strings.Repeat("x", 33)
	for _, bad := range []string{"nope", "null", "{}", `{"itemId":"<<"}`, `{` + id + `,"codec":"` + long + `"}`, `{` + id + `,"quality":"` + long + `"}`} {
		if s, _, _, _ := Do(NewRouter(), Session{Use: u}, "POST", PlaybackPath, bad); s != 400 {
			t.Errorf("%s: %d, want 400", bad, s)
		}
	}
	if s, _, _, _ := Do(NewRouter(), Session{Use: u}, "POST", PlaybackPath, `{`+id+`}`); s != 204 {
		t.Fatalf("an id alone: %d", s)
	}
}
