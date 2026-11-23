package history

import (
	"net/http"
	"slices"
	"sync"
	"time"

	"streamiq/gateway/internal/tunnel"
	"streamiq/protocol"
)

// Window is how far back GET /streamiq/health reaches.
const Window = HealthDays * 24 * time.Hour

// entry is one stored health row: the heartbeat's health, stamped.
type entry struct {
	At             time.Time `json:"at"`
	GatewayVersion string    `json:"gatewayVersion"`
	protocol.Health
}

// Health records the box's health and serves it back.
type Health struct {
	Store   *Store
	Version string // the gateway's
	mu      sync.Mutex
	last    *entry
	loaded  bool
}

// Record stores h unless it adds nothing: a row when Jellyfin, OS/arch, transcoding,
// the offline jail or the gateway version change, at least every 5 min, at most
// one per 25 s. Live counts and load alone don't make one.
func (s *Health) Record(now time.Time, h protocol.Health) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.loaded { // after a restart the rule goes on from the stored latest row
		rows, err := Read[entry](s.Store)
		if err != nil {
			return err
		}
		if len(rows) > 0 {
			s.last = &rows[len(rows)-1]
		}
		s.loaded = true
	}
	e := entry{At: now.UTC(), GatewayVersion: s.Version, Health: h}
	if l := s.last; l != nil {
		age := now.Sub(l.At)
		// A clock set back (negative age) records again rather than waiting for the old time.
		if age >= 0 && (age < 25*time.Second || age < 5*time.Minute && same(*l, e)) {
			return nil
		}
	}
	if err := s.Store.Append(now, e); err != nil {
		return err
	}
	s.last = &e
	return nil
}

func same(a, b entry) bool {
	return a.Jellyfin == b.Jellyfin && a.OS == b.OS && a.Arch == b.Arch &&
		a.Transcoding == b.Transcoding && a.Offline == b.Offline && a.GatewayVersion == b.GatewayVersion
}

// ServeHTTP is GET /streamiq/health: the rows of the last Window, oldest first, led by
// the latest row before it (the state the window starts in).
func (s *Health) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	rows, err := Read[entry](s.Store)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	tunnel.JSON(w, http.StatusOK, window(rows, time.Now()))
}

func window(rows []entry, now time.Time) []HealthRow {
	// A clock set back writes rows out of order: the answer is ordered anyway.
	slices.SortStableFunc(rows, func(a, b entry) int { return a.At.Compare(b.At) })
	start := now.Add(-Window)
	first := len(rows)
	for i, r := range rows {
		if !r.At.Before(start) {
			first = i
			break
		}
	}
	first = max(first-1, 0) // the lead row, if any
	out := []HealthRow{}
	for _, r := range rows[first:] {
		out = append(out, row(r))
	}
	return out
}

func row(e entry) HealthRow {
	return HealthRow{
		At:                e.At,
		JellyfinReachable: &e.Jellyfin.Reachable,
		JellyfinVersion:   orNil(e.Jellyfin.Version),
		GatewayVersion:    orNil(e.GatewayVersion),
		Tunnels:           &e.Tunnels,
		Transcodes:        e.Transcodes,
		CPU:               e.CPU,
		Memory:            e.Memory,
	}
}

func orNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
