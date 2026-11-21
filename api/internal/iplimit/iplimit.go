// Package iplimit is the per-client-IP request budget the broker's sockets, enrollment
// and enrollment tokens share: one budget, as one flood shield. Loose on purpose: users
// behind one carrier NAT share it. ponytail: in memory, one API instance, no per-user limit.
package iplimit

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Limiter lets each client IP make max requests a minute through every handler it wraps.
type Limiter struct {
	// header names the request header with the client's IP (Railway: X-Real-IP); empty
	// or missing = the connection's address. Never X-Forwarded-For: the client writes
	// its left entries.
	header string

	mu     sync.Mutex
	max    int
	start  time.Time
	counts map[string]int
}

func New(perMinute int, header string) *Limiter {
	return &Limiter{header: header, max: perMinute, counts: map[string]int{}}
}

// Wrap answers 429 once the client's IP spent this minute's budget.
func (l *Limiter) Wrap(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !l.allow(l.ip(r), time.Now()) {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		h(w, r)
	}
}

func (l *Limiter) ip(r *http.Request) string {
	if ip := strings.TrimSpace(r.Header.Get(l.header)); l.header != "" && ip != "" {
		return ip
	}
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	return ip
}

// allow is a fixed one-minute window. ponytail: one window for all IPs, reset whole;
// per-IP windows if a burst at a window's edge ever matters.
func (l *Limiter) allow(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.start) >= time.Minute {
		l.start, l.counts = now, map[string]int{}
	}
	l.counts[ip]++
	return l.counts[ip] <= l.max
}
