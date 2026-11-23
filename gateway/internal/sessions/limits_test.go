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
	var line string
	s.Ended = func(r protocol.Report, user string, _ time.Time, _ int) { line = r.Session + "/" + user }
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
	if line != "s9/u" {
		t.Fatalf("history line %q, want the refused tunnel's", line)
	}
}

// deadline: closed at UnauthedFor unless authed; a pairing exchange postpones it
// until the exchange ends; ICE that never connected ends as an ICE failure.
func TestUnauthedDeadline(t *testing.T) {
	type conn struct {
		s         *Sessions
		pre       *preAuth
		connected atomic.Bool
		ended     atomic.Value // the iceFailed it ended with; nil = still open
		why       atomic.Value
	}
	run := func(t *testing.T, f func(c *conn)) {
		synctest.Test(t, func(t *testing.T) {
			c := &conn{s: &Sessions{ends: map[string]func(bool){}}}
			c.pre = c.s.admit()
			c.connected.Store(true)
			c.s.ends["s"] = func(iceFailed bool) {
				c.pre.leave()
				c.ended.Store(iceFailed)
				c.s.mu.Lock()
				delete(c.s.ends, "s")
				c.s.mu.Unlock()
			}
			c.s.deadline("s", c.pre, c.connected.Load, &c.why)
			f(c)
		})
	}
	t.Run("closed at the deadline", func(t *testing.T) {
		run(t, func(c *conn) {
			<-time.After(UnauthedFor - time.Millisecond) // the bubble's fake clock
			synctest.Wait()
			if c.ended.Load() != nil {
				t.Fatal("closed before the deadline")
			}
			<-time.After(time.Millisecond)
			synctest.Wait()
			if c.ended.Load() != false || c.why.Load() != "not authenticated within 30s" || c.s.unauthed != 0 {
				t.Fatalf("at the deadline: ended %v, why %v, unauthed %d", c.ended.Load(), c.why.Load(), c.s.unauthed)
			}
		})
	})
	t.Run("ICE never connected", func(t *testing.T) {
		run(t, func(c *conn) {
			c.connected.Store(false)
			<-time.After(UnauthedFor)
			synctest.Wait()
			if c.ended.Load() != true || c.why.Load() != nil {
				t.Fatalf("ended %v, why %v: want an ICE failure, no auth reason", c.ended.Load(), c.why.Load())
			}
		})
	})
	t.Run("authed in time", func(t *testing.T) {
		run(t, func(c *conn) {
			c.pre.passed.Store(true)
			<-time.After(2 * UnauthedFor)
			synctest.Wait()
			if c.ended.Load() != nil {
				t.Fatal("an authed session must stay")
			}
		})
	})
	t.Run("pairing postpones it", func(t *testing.T) {
		run(t, func(c *conn) {
			c.pre.pairing.Store(true)
			<-time.After(3 * UnauthedFor)
			synctest.Wait()
			if c.ended.Load() != nil {
				t.Fatal("closed during a pairing exchange")
			}
			c.pre.pairing.Store(false) // rejected: still not authenticated
			<-time.After(UnauthedFor)
			synctest.Wait()
			if c.ended.Load() == nil {
				t.Fatal("still open a round after the exchange ended unapproved")
			}
		})
	})
}
