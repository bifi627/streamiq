package sessions

import (
	"testing"

	"github.com/pion/webrtc/v4"
)

func TestCheckOffer(t *testing.T) {
	sdp := &webrtc.SessionDescription{}
	for _, c := range []struct {
		name string
		m    Msg
		live bool
		want int
	}{
		{"admin", Msg{SDP: sdp, User: "u", Role: "admin"}, false, offerAccept},
		{"member", Msg{SDP: sdp, User: "u", Role: "member"}, false, offerAccept},
		{"live session", Msg{SDP: sdp, User: "u", Role: "admin"}, true, offerIgnore},
		{"no sdp", Msg{User: "u", Role: "admin"}, false, offerIgnore},
		{"no user", Msg{SDP: sdp, Role: "admin"}, false, offerRefuse},
		{"no role", Msg{SDP: sdp, User: "u"}, false, offerRefuse},
		{"unknown role", Msg{SDP: sdp, User: "u", Role: "owner"}, false, offerRefuse},
	} {
		if got := checkOffer(c.m, c.live); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}

func TestAccepts(t *testing.T) {
	fresh := authState{}
	unpaired := authState{keyed: true}
	ok := authState{keyed: true, authed: true}
	committed := authState{keyed: true, committed: true}
	revealed := authState{keyed: true, committed: true, revealed: true}
	for _, c := range []struct {
		name string
		st   authState
		typ  string
		want bool
	}{
		{"auth first", fresh, "auth", true},
		{"commit before auth", fresh, "commit", false},
		{"reveal before auth", fresh, "reveal", false},
		{"second auth", unpaired, "auth", false},
		{"commit after unpaired", unpaired, "commit", true},
		{"reveal before commit", unpaired, "reveal", false},
		{"commit once authed", ok, "commit", false},
		{"second commit", committed, "commit", false},
		{"reveal after commit", committed, "reveal", true},
		{"second reveal", revealed, "reveal", false},
		{"unknown type", fresh, "hello", false},
		{"empty type", unpaired, "", false},
	} {
		if got := c.st.accepts(c.typ); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestFailure(t *testing.T) {
	for _, c := range []struct {
		iceFailed, authed bool
		why               string
		want              string // "" = nil
	}{
		{true, false, "", "ice failed"},
		{true, true, "", "ice failed"}, // ICE failing wins even after auth
		{false, true, "unpaired", ""},  // authed: no failure, whatever came before
		{false, false, "unpaired", "unpaired"},
		{false, false, "not approved", "not approved"},
		{false, false, "", "ended before auth"},
	} {
		got := ""
		if f := failure(c.iceFailed, c.authed, c.why); f != nil {
			got = *f
		}
		if got != c.want {
			t.Errorf("failure(%v, %v, %q) = %q, want %q", c.iceFailed, c.authed, c.why, got, c.want)
		}
	}
}
