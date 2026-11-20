//go:build unix

package host

import "golang.org/x/sys/unix"

func readDisk(dir string) *Disk {
	var st unix.Statfs_t
	if unix.Statfs(dir, &st) != nil {
		return nil
	}
	// The field types differ per OS (Bsize: int64 on linux, uint32 on darwin).
	bs := uint64(st.Bsize)
	return &Disk{Free: uint64(st.Bavail) * bs, Total: uint64(st.Blocks) * bs}
}
