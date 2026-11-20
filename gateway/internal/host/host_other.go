//go:build !linux && !windows

package host

// ponytail: no CPU or memory on macOS (best effort); host_statistics via cgo if a Mac user needs it.
func readCPU() (cpuTimes, bool) { return cpuTimes{}, false }

func readMemory() *Memory { return nil }
