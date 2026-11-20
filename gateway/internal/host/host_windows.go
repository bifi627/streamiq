package host

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// x/sys/windows has no wrappers for these two.
var (
	kernel32             = windows.NewLazySystemDLL("kernel32.dll")
	getSystemTimes       = kernel32.NewProc("GetSystemTimes")
	globalMemoryStatusEx = kernel32.NewProc("GlobalMemoryStatusEx")
)

func ft(f windows.Filetime) uint64 { return uint64(f.HighDateTime)<<32 | uint64(f.LowDateTime) }

// readCPU: GetSystemTimes' kernel time includes its idle time.
func readCPU() (cpuTimes, bool) {
	var idle, kernel, user windows.Filetime
	r, _, _ := getSystemTimes.Call(
		uintptr(unsafe.Pointer(&idle)), uintptr(unsafe.Pointer(&kernel)), uintptr(unsafe.Pointer(&user)))
	if r == 0 {
		return cpuTimes{}, false
	}
	return cpuTimes{idle: ft(idle), total: ft(kernel) + ft(user)}, true
}

// memoryStatusEx is MEMORYSTATUSEX.
type memoryStatusEx struct {
	length, memoryLoad                   uint32
	totalPhys, availPhys                 uint64
	totalPageFile, availPageFile         uint64
	totalVirtual, availVirtual, availExt uint64
}

func readMemory() *Memory {
	m := memoryStatusEx{length: uint32(unsafe.Sizeof(memoryStatusEx{}))}
	if r, _, _ := globalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&m))); r == 0 || m.availPhys > m.totalPhys {
		return nil
	}
	return &Memory{Used: m.totalPhys - m.availPhys, Total: m.totalPhys}
}

func readDisk(dir string) *Disk {
	p, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return nil
	}
	var d Disk
	if windows.GetDiskFreeSpaceEx(p, &d.Free, &d.Total, nil) != nil {
		return nil
	}
	return &d
}
