// Package host measures the gateway box's load (CPU, memory, disk) for
// GET /streamiq/status: live only, never stored.
package host

import (
	"context"
	"sync"
	"time"
)

// Interval is how often the sampler reads the CPU: the reported busy % is the
// average over the last Interval.
const Interval = 10 * time.Second

// cpuTimes are cumulative CPU counters since boot, in any one unit.
type cpuTimes struct{ idle, total uint64 }

// busy is the busy % between two readings; ok is false when no time passed
// (or the counters went backwards).
func busy(a, b cpuTimes) (pct float64, ok bool) {
	if b.total <= a.total || b.idle < a.idle {
		return 0, false
	}
	dt, di := b.total-a.total, b.idle-a.idle
	return 100 * float64(dt-min(di, dt)) / float64(dt), true
}

// Sampler keeps the CPU busy % and the cache disk fresh in the background, so a
// status request never waits for a measurement. Compose is the managed
// Jellyfin's compose file ("" = no disk).
type Sampler struct {
	Compose string
	mu      sync.Mutex
	cpu     *float64
	disk    *Disk
}

// Run samples every Interval until ctx ends.
func (s *Sampler) Run(ctx context.Context) {
	prev, cpuOK := readCPU()
	t := time.NewTicker(Interval)
	defer t.Stop()
	for {
		d := cacheDisk(ctx, s.Compose)
		s.mu.Lock()
		s.disk = d
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if cpuOK {
			prev = s.sampleCPU(prev)
		}
	}
}

// sampleCPU stores the busy % since prev and returns the new reading.
func (s *Sampler) sampleCPU(prev cpuTimes) cpuTimes {
	cur, ok := readCPU()
	if !ok {
		return prev
	}
	if pct, ok := busy(prev, cur); ok {
		s.mu.Lock()
		s.cpu = &pct
		s.mu.Unlock()
	}
	return cur
}

// Load is the box's load now.
func (s *Sampler) Load() Load {
	s.mu.Lock()
	l := Load{CPU: s.cpu, Disk: s.disk}
	s.mu.Unlock()
	l.Memory = readMemory()
	return l
}
