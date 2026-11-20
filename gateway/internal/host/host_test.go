package host

import (
	"path/filepath"
	"testing"
)

func TestBusyFromTwoReadings(t *testing.T) {
	a := cpuTimes{idle: 1000, total: 2000}
	if pct, ok := busy(a, cpuTimes{idle: 1100, total: 2400}); !ok || pct != 75 {
		t.Fatalf("busy = %v, %v; want 75, true", pct, ok)
	}
	if pct, ok := busy(a, cpuTimes{idle: 1400, total: 2400}); !ok || pct != 0 {
		t.Fatalf("all idle: busy = %v, %v; want 0, true", pct, ok)
	}
	if _, ok := busy(a, a); ok {
		t.Fatal("no time passed: want ok false")
	}
}

func TestNoComposeNoDisk(t *testing.T) {
	var s Sampler
	if l := s.Load(filepath.Join(t.TempDir(), "jellyfin-compose.yml")); l.Disk != nil {
		t.Fatalf("disk = %+v without a compose file; want none", l.Disk)
	}
}
