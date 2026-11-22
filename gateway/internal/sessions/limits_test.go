package sessions

import (
	"encoding/json"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/pion/webrtc/v4"

	"streamiq/gateway/internal/tunnel"
	"streamiq/protocol"
)

// MaxUnauthed places: at the limit passes, one over is refused; a place given
// back (twice: once) is free again.
func TestAdmitAtMaxUnauthed(t *testing.T) {
	s := &Sessions{}
	held := make([]*preAuth, MaxUnauthed)
	for i := range held {
		if held[i] = s.admit(); held[i] == nil {
			t.Fatalf("place %d refused below MaxUnauthed", i+1)
		}
	}
	if s.admit() != nil {
		t.Fatal("want a refusal one over MaxUnauthed")
	}
	held[0].leave()
	held[0].leave()
	if s.admit() == nil {
		t.Fatal("a place given back must be free again")
	}
	if s.admit() != nil {
		t.Fatal("leave twice must give back one place")
	}
}

// An offer over MaxUnauthed builds no PeerConnection; the broker gets the error
// for that session and its tunnel report the same failure.
func TestOfferOverMaxUnauthedRefused(t *testing.T) {
	s := &Sessions{}
	for range MaxUnauthed {
		s.admit()
	}
	var report []any
	s.Handle(nil, func(v any) { report = append(report, v) }) // the control socket is up
	var sent []any
	raw, _ := json.Marshal(Msg{Type: "offer", Session: "s9", User: "u", Role: tunnel.Member,
		SDP: &webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: "v=0"}})
	s.Handle(raw, func(v any) { sent = append(sent, v) })

	if s.Active() != 0 {
		t.Fatal("a refused offer must not build a PeerConnection")
	}
	want := protocol.GatewayError{Type: "error", Session: "s9", Error: busy}
	if len(sent) != 1 || sent[0] != want {
		t.Fatalf("sent %v, want %v", sent, want)
	}
	if len(report) != 1 {
		t.Fatalf("reports = %v", report)
	}
	if r := report[0].(protocol.Report); r.Session != "s9" || r.Failure == nil || *r.Failure != busy {
		t.Fatalf("report = %+v, want failure %q", r, busy)
	}
}

// deadline: closed at UnauthedFor unless authed; a pairing exchange postpones it
// until the exchange ends.
func TestUnauthedDeadline(t *testing.T) {
	run := func(t *testing.T, f func(s *Sessions, pre *preAuth, authed *atomic.Bool, ended *atomic.Bool, why *atomic.Value)) {
		synctest.Test(t, func(t *testing.T) {
			s := &Sessions{ends: map[string]func(bool){}}
			pre := s.admit()
			var authed, ended atomic.Bool
			var why atomic.Value
			s.ends["s"] = func(bool) {
				pre.leave()
				ended.Store(true)
				s.mu.Lock()
				delete(s.ends, "s")
				s.mu.Unlock()
			}
			s.deadline("s", pre, &authed, &why)
			f(s, pre, &authed, &ended, &why)
		})
	}
	t.Run("closed at the deadline", func(t *testing.T) {
		run(t, func(s *Sessions, _ *preAuth, _, ended *atomic.Bool, why *atomic.Value) {
			time.Sleep(UnauthedFor - time.Millisecond)
			synctest.Wait()
			if ended.Load() {
				t.Fatal("closed before the deadline")
			}
			time.Sleep(time.Millisecond)
			synctest.Wait()
			if !ended.Load() || why.Load() != "not authenticated within 30s" || s.unauthed != 0 {
				t.Fatalf("at the deadline: ended %v, why %v, unauthed %d", ended.Load(), why.Load(), s.unauthed)
			}
		})
	})
	t.Run("authed in time", func(t *testing.T) {
		run(t, func(_ *Sessions, _ *preAuth, authed, ended *atomic.Bool, _ *atomic.Value) {
			authed.Store(true)
			time.Sleep(2 * UnauthedFor)
			synctest.Wait()
			if ended.Load() {
				t.Fatal("an authed session must stay")
			}
		})
	})
	t.Run("pairing postpones it", func(t *testing.T) {
		run(t, func(_ *Sessions, pre *preAuth, _, ended *atomic.Bool, _ *atomic.Value) {
			pre.pairing.Store(true)
			time.Sleep(3 * UnauthedFor)
			synctest.Wait()
			if ended.Load() {
				t.Fatal("closed during a pairing exchange")
			}
			pre.pairing.Store(false) // rejected: still not authenticated
			time.Sleep(UnauthedFor)
			synctest.Wait()
			if !ended.Load() {
				t.Fatal("still open a round after the exchange ended unapproved")
			}
		})
	})
}
