package host

import "testing"

func TestParseProc(t *testing.T) {
	c, ok := parseStat([]byte("cpu  10 1 5 80 4 0 0 0 7 0\ncpu0 1 2 3 4\n"))
	if !ok || c != (cpuTimes{idle: 84, total: 100}) {
		t.Fatalf("parseStat = %+v, %v", c, ok)
	}
	m := parseMeminfo([]byte("MemTotal:       16000 kB\nMemFree:  1000 kB\nMemAvailable:    4000 kB\n"))
	if m == nil || *m != (Memory{Used: 12000 * 1024, Total: 16000 * 1024}) {
		t.Fatalf("parseMeminfo = %+v", m)
	}
}
