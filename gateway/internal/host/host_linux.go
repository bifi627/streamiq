package host

import (
	"bufio"
	"bytes"
	"os"
	"strconv"
	"strings"
)

func readCPU() (cpuTimes, bool) {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return cpuTimes{}, false
	}
	return parseStat(b)
}

// parseStat reads the "cpu" line: user nice system idle iowait irq softirq steal
// (guest time is already in user). Idle counts iowait too.
func parseStat(b []byte) (cpuTimes, bool) {
	line, _, _ := bytes.Cut(b, []byte("\n"))
	f := strings.Fields(string(line))
	if len(f) < 5 || f[0] != "cpu" {
		return cpuTimes{}, false
	}
	var t cpuTimes
	for i, s := range f[1:min(len(f), 9)] {
		n, err := strconv.ParseUint(s, 10, 64)
		if err != nil {
			return cpuTimes{}, false
		}
		t.total += n
		if i == 3 || i == 4 {
			t.idle += n
		}
	}
	return t, true
}

func readMemory() *Memory {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return nil
	}
	return parseMeminfo(b)
}

// parseMeminfo: used = MemTotal - MemAvailable (kB in the file).
func parseMeminfo(b []byte) *Memory {
	kb := map[string]uint64{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		if n, err := strconv.ParseUint(strings.TrimSuffix(strings.TrimSpace(v), " kB"), 10, 64); err == nil {
			kb[k] = n
		}
	}
	total, avail := kb["MemTotal"], kb["MemAvailable"]
	if total == 0 || avail > total {
		return nil
	}
	return &Memory{Used: (total - avail) * 1024, Total: total * 1024}
}
