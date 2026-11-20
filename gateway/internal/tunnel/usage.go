package tunnel

import (
	"strings"
	"sync"
	"time"
)

// uses names what a tunnel was for, highest rank first: a tunnel reports the
// highest-ranked use among the requests it served (docs/protocol.md, "Telemetry").
// A new use is a row here; the API stores any word.
var uses = []struct {
	name string
	rule func(method, path string) bool
}{
	{"playback", func(m, p string) bool { return m == "GET" && videoRead.MatchString(p) }},
	{"browsing", func(_, p string) bool { return !isGatewayAPI(p) }},
	{"diagnostics", func(_, p string) bool { return strings.EqualFold(p, BurstPath) }},
	{"management", func(_, p string) bool { return isGatewayAPI(p) }},
}

// Usage is one tunnel's use and active time, recorded as its requests end.
type Usage struct {
	start time.Time // the offer arrived

	mu   sync.Mutex
	rank int       // index into uses; len(uses) = no request yet
	last time.Time // the end of the last request
}

func NewUsage(start time.Time) *Usage { return &Usage{start: start, rank: len(uses)} }

// record notes a request that ended at; nil u (a test session) records nothing.
func (u *Usage) record(method, path string, at time.Time) {
	if u == nil {
		return
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	for i, use := range uses[:u.rank] {
		if use.rule(method, path) {
			u.rank = i
			break
		}
	}
	if at.After(u.last) {
		u.last = at
	}
}

// Summary is the report's use and activeMs: "" and nil when no request was served.
func (u *Usage) Summary() (string, *int64) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.last.IsZero() {
		return "", nil
	}
	ms := u.last.Sub(u.start).Milliseconds()
	return uses[u.rank].name, &ms // every path matches browsing or management
}
