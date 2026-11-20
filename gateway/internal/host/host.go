// Package host measures the gateway box's load (CPU, memory, disk) for
// GET /streamiq/status: live only, never stored.
package host

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Interval is how often the sampler reads the CPU: the reported busy % is the
// average over the last Interval.
const Interval = 10 * time.Second

// Load is the status's `host` field. A field the platform can't measure is nil.
type Load struct {
	CPU    *float64 `json:"cpu,omitempty"` // busy %, 0–100
	Memory *Memory  `json:"memory,omitempty"`
	Disk   *Disk    `json:"disk,omitempty"`
}

// Memory is physical memory in bytes.
type Memory struct {
	Used  uint64 `json:"used"`
	Total uint64 `json:"total"`
}

// Disk is the drive holding a folder, in bytes; Free is what this process may use.
type Disk struct {
	Free  uint64 `json:"free"`
	Total uint64 `json:"total"`
}

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

// Sampler keeps the CPU busy % fresh in the background, so a status request
// never waits for a measurement.
type Sampler struct {
	mu  sync.Mutex
	cpu *float64
}

// Run samples the CPU every Interval until ctx ends.
func (s *Sampler) Run(ctx context.Context) {
	prev, ok := readCPU()
	if !ok {
		return
	}
	t := time.NewTicker(Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		cur, ok := readCPU()
		if !ok {
			continue
		}
		if pct, ok := busy(prev, cur); ok {
			s.mu.Lock()
			s.cpu = &pct
			s.mu.Unlock()
		}
		prev = cur
	}
}

// Load is the box's load now. compose is the managed Jellyfin's compose file:
// disk is the drive of its folder (where jellyfin-config lives), none without it.
func (s *Sampler) Load(compose string) Load {
	s.mu.Lock()
	l := Load{CPU: s.cpu}
	s.mu.Unlock()
	l.Memory = readMemory()
	if _, err := os.Stat(compose); err == nil {
		l.Disk = readDisk(filepath.Dir(compose))
	}
	return l
}
