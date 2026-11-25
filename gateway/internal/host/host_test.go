package host

import (
	"context"
	"os"
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

func TestParseDF(t *testing.T) {
	d := parseDF([]byte("        Avail     1B-blocks\n 120000000000 1000000000000\n"))
	if d == nil || d.Free != 120000000000 || d.Total != 1000000000000 {
		t.Fatalf("disk = %+v; want 120 GB free of 1 TB", d)
	}
	for _, bad := range []string{"", "Avail 1B-blocks\n", "Avail 1B-blocks\n12 x\n", "Avail 1B-blocks\n5 4\n",
		"Error response from daemon: container is not running\n"} {
		if d := parseDF([]byte(bad)); d != nil {
			t.Errorf("parseDF(%q) = %+v; want none", bad, d)
		}
	}
}

func TestSmallerByFree(t *testing.T) {
	vm, drive := &Disk{Free: 997, Total: 1081}, &Disk{Free: 103, Total: 999}
	if d := smaller(vm, drive); d != drive {
		t.Fatalf("smaller = %+v; want the drive", d)
	}
	if d := smaller(drive, vm); d != drive {
		t.Fatalf("smaller = %+v; want the drive", d)
	}
	if smaller(nil, drive) != drive || smaller(vm, nil) != vm || smaller(nil, nil) != nil {
		t.Fatal("one missing: want the other")
	}
}

func TestCacheDiskWithoutJellyfin(t *testing.T) {
	dir := t.TempDir()
	if d := cacheDisk(context.Background(), filepath.Join(dir, "jellyfin-compose.yml")); d != nil {
		t.Fatalf("disk = %+v without a compose file; want none", d)
	}
	bad := filepath.Join(dir, "broken.yml") // docker missing or compose refusing it: the command fails
	if err := os.WriteFile(bad, []byte("services: [\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if d := inContainer(context.Background(), bad); d != nil {
		t.Fatalf("disk = %+v when the command fails; want none", d)
	}
	// Total, not Free: the free bytes can move between the two reads.
	if d, drive := cacheDisk(context.Background(), bad), readDisk(dir); d == nil || d.Total != drive.Total {
		t.Fatalf("disk = %+v when the command fails; want the compose folder's drive %+v", d, drive)
	}
}
