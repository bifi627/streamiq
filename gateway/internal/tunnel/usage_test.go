package tunnel

import (
	"net/http/httptest"
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
	if _, ms := u.Summary(); *ms != 5000 {
		t.Fatalf("activeMs %d, want 5000", *ms)
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
