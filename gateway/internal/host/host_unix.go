//go:build unix

package host

import "golang.org/x/sys/unix"

func readDisk(dir string) *Disk {
	var st unix.Statfs_t
	if unix.Statfs(dir, &st) != nil {
		return nil
	}
	bs := uint64(st.Bsize) //nolint:gosec,unconvert // int64 on linux, uint32 on darwin; never negative
	return &Disk{Free: uint64(st.Bavail) * bs, Total: uint64(st.Blocks) * bs} //nolint:unconvert // int64 on some BSDs
}
