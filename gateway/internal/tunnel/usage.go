package tunnel

import (
	"slices"
	"strings"
	"sync"
	"time"
)

// uses names what a tunnel was for, highest rank first: a tunnel reports the
// highest-ranked use among the requests it served (docs/protocol.md, "Tunnel report").
// A new use is a row here (and a web label).
var uses = []struct {
	name string
	rule func(method, path string) bool
}{
	{"playback", func(m, p string) bool { return m == "GET" && videoRead.MatchString(p) }},
	{"browsing", func(_, p string) bool { return !isGatewayAPI(p) }},
	{"diagnostics", func(_, p string) bool { return strings.EqualFold(p, BurstPath) }},
	{"management", func(_, p string) bool { return isGatewayAPI(p) }},
}

// Usage is one tunnel's use and active time, recorded as its requests end, and the
// throughput and playbacks its browser measured.
type Usage struct {
	start time.Time // the offer arrived

	mu    sync.Mutex
	rank  int       // index into uses; len(uses) = no request yet
	last  time.Time // the end of the last request
	kbps  int       // 0 = none measured
	plays []Playback
}

// PlaybackCap caps a tunnel's playbacks: the latest ones are kept.
// ponytail: a long-lived tunnel keeps its last 20 only; a per-day file if more matter.
const PlaybackCap = 20

func NewUsage(start time.Time) *Usage { return &Usage{start: start, rank: len(uses)} }

// record notes a request that ended at; nil u (a test session) records nothing.
func (u *Usage) record(method, path string, at time.Time) {
	// The throughput report comes as the tunnel closes, after a shared tunnel's idle
	// wait, a playback's as the player closes: neither is a use or active time.
	if u == nil || strings.EqualFold(path, ThroughputPath) || strings.EqualFold(path, PlaybackPath) {
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

// Start is when the tunnel's offer arrived.
func (u *Usage) Start() time.Time { return u.start }

// SetThroughput keeps the gateway → client throughput the browser measured on this
// tunnel; zero or negative = none. nil u (a test session) keeps nothing.
func (u *Usage) SetThroughput(kbps int) {
	if u == nil {
		return
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	u.kbps = max(kbps, 0)
}

// Throughput is SetThroughput's value; 0 = none.
func (u *Usage) Throughput() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.kbps
}

// AddPlayback keeps one playback's summary; nil u (a test session) keeps nothing.
func (u *Usage) AddPlayback(p Playback) {
	if u == nil {
		return
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	u.plays = append(u.plays, p)
	if len(u.plays) > PlaybackCap {
		u.plays = u.plays[len(u.plays)-PlaybackCap:]
	}
}

// Playbacks is AddPlayback's summaries, oldest first; nil = none.
func (u *Usage) Playbacks() []Playback {
	u.mu.Lock()
	defer u.mu.Unlock()
	return slices.Clone(u.plays)
}
