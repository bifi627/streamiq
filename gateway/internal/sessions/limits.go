// Bounds on work done before a connection authenticates (docs/protocol.md, "Pairing +
// connection auth"): how many such connections, and for how long.

package sessions

import (
	"log"
	"sync"
	"sync/atomic"
	"time"

	"streamiq/protocol"
)

const (
	// MaxUnauthed: connections that haven't passed connection auth yet, at once. An
	// offer over it gets no PeerConnection.
	MaxUnauthed = 8
	// UnauthedFor: how long after its offer a connection may stay unauthenticated
	// outside a pairing exchange before the gateway closes it.
	UnauthedFor = 30 * time.Second
	// busy is the refused offer's error and tunnel failure (the browser reads it).
	busy = "gateway busy"
)

// preAuth is one connection's standing against the limits until it authenticates.
type preAuth struct {
	leave   func()      // gives back its MaxUnauthed place; once, on auth or end
	pairing atomic.Bool // a pairing exchange runs (accepted commit): the deadline waits for it
	passed  atomic.Bool // ok or approved, set before the viewer is made (that can take a while)
}

// admit takes one of the MaxUnauthed places; nil = none free.
func (s *Sessions) admit() *preAuth {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.unauthed >= MaxUnauthed {
		return nil
	}
	s.unauthed++
	return &preAuth{leave: sync.OnceFunc(func() {
		s.mu.Lock()
		s.unauthed--
		s.mu.Unlock()
	})}
}

// refuse answers an offer over MaxUnauthed: the broker relays the error to the
// browser, the report gives its tunnel row the failure.
func (s *Sessions) refuse(id string, send func(any)) {
	log.Printf("gateway: session %s: refused, %d connections not authenticated yet", id, MaxUnauthed)
	send(protocol.GatewayError{Type: "error", Session: id, Error: busy})
	s.report(protocol.Report{Type: "tunnel", Session: id, Failure: ptr(busy)})
}

// deadline closes the connection UnauthedFor after its offer unless it has
// authenticated by then; a pairing exchange still running gets another round.
// ICE that never connected (connected false) ends as "ice failed": pion's own
// failure comes only 30 s after checking starts, later than this.
func (s *Sessions) deadline(id string, pre *preAuth, connected func() bool, why *atomic.Value) {
	var check func()
	check = func() {
		s.mu.Lock()
		end := s.ends[id]
		s.mu.Unlock()
		switch {
		case end == nil || pre.passed.Load():
		case pre.pairing.Load():
			time.AfterFunc(UnauthedFor, check)
		case !connected():
			end(true)
		default:
			why.Store("not authenticated within " + UnauthedFor.String())
			end(false)
		}
	}
	time.AfterFunc(UnauthedFor, check)
}
