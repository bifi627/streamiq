package host

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// cacheDisk is the disk transcodes fill: the smaller of the filesystem behind
// /cache in the managed Jellyfin container and the compose folder's drive; nil
// without the compose file or when neither can be read. Docker Desktop's VM disk
// is sparse and, by default, on the compose folder's drive: inside it claims far
// more free space than that drive has. The host can't reach a named volume
// itself (it lives in Docker Desktop's VM; /var/lib/docker is root-only on Linux).
// ponytail: a VM disk moved to another drive goes unmeasured; Docker Desktop's
// settings file names its folder if that bites.
func cacheDisk(ctx context.Context, compose string) *Disk {
	if _, err := os.Stat(compose); err != nil {
		return nil
	}
	return smaller(inContainer(ctx, compose), readDisk(filepath.Dir(compose)))
}

func smaller(a, b *Disk) *Disk {
	if a == nil || (b != nil && b.Free < a.Free) {
		return b
	}
	return a
}

// inContainer is `df` of /cache inside the running Jellyfin container.
func inContainer(ctx context.Context, compose string) *Disk {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "compose", "-f", compose,
		"exec", "-T", "jellyfin", "df", "-B1", "--output=avail,size", "/cache").Output()
	if err != nil {
		return nil
	}
	return parseDF(out)
}

// parseDF reads `df -B1 --output=avail,size`: a header line, then "<avail> <size>".
func parseDF(out []byte) *Disk {
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) != 2 {
		return nil
	}
	f := strings.Fields(lines[1])
	if len(f) != 2 {
		return nil
	}
	free, err1 := strconv.ParseUint(f[0], 10, 64)
	total, err2 := strconv.ParseUint(f[1], 10, 64)
	if err1 != nil || err2 != nil || free > total {
		return nil
	}
	return &Disk{Free: free, Total: total}
}
