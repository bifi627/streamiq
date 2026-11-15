// Package backup packs the gateway's state dir into one zip and unpacks it
// again (`gateway backup` / `gateway restore`, #52). The zip is not encrypted:
// whoever has it can pose as the gateway (docs/install.md).
package backup

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

// skip: machine-specific (the page login is per LAN address, made again on start).
var skip = []string{"page-token", "page-link"}

// required: without these a restore brings back nothing worth having.
var required = []string{"cert.pem", "gateway.json"}

// maxFile caps one unpacked file: the real ones are a few KB.
const maxFile = 10 << 20

// FileName is the default backup name: streamiq-gateway-<name>-<date>.zip.
func FileName(dir string, now time.Time) string {
	var st struct{ Name string }
	b, _ := os.ReadFile(filepath.Join(dir, "gateway.json"))
	_ = json.Unmarshal(b, &st)
	name := strings.Trim(regexp.MustCompile(`[^A-Za-z0-9._-]+`).ReplaceAllString(st.Name, "-"), "-.")
	if name != "" {
		name += "-"
	}
	return "streamiq-gateway-" + name + now.Format("2006-01-02") + ".zip"
}

// Write zips every regular file in dir except skip. It only reads, so it works
// while the gateway runs.
func Write(dir string, w io.Writer) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	zw := zip.NewWriter(w)
	have := 0
	for _, e := range entries {
		if !e.Type().IsRegular() || slices.Contains(skip, e.Name()) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return err
		}
		// The gateway rewrites its JSON files in place: a read mid-write is cut short.
		if strings.HasSuffix(e.Name(), ".json") && !json.Valid(b) {
			return fmt.Errorf("%s was being written: run the backup again", e.Name())
		}
		f, err := zw.Create(e.Name())
		if err != nil {
			return err
		}
		if _, err := f.Write(b); err != nil {
			return err
		}
		if slices.Contains(required, e.Name()) {
			have++
		}
	}
	if have != len(required) {
		return fmt.Errorf("%s has no gateway identity (%s): nothing to back up", dir, strings.Join(required, ", "))
	}
	return zw.Close()
}

// Restore unpacks the zip at path into dir. It checks the whole zip before it
// writes anything, and refuses to replace an existing identity unless force.
func Restore(path, dir string, force bool) error {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer zr.Close()
	var names []string
	for _, f := range zr.File {
		n := f.Name
		// Flat names only: no directories, no zip-slip.
		if n == "" || n == "." || n == ".." || strings.ContainsAny(n, `/\:`) || f.FileInfo().IsDir() {
			return fmt.Errorf("%s: not a gateway backup (entry %q)", path, n)
		}
		names = append(names, n)
	}
	for _, r := range required {
		if !slices.Contains(names, r) {
			return fmt.Errorf("%s: not a gateway backup (no %s)", path, r)
		}
	}
	if !force {
		var there []string
		for _, r := range required {
			if _, err := os.Stat(filepath.Join(dir, r)); err == nil {
				there = append(there, r)
			}
		}
		if len(there) > 0 {
			return fmt.Errorf("%s already holds a gateway (%s): restoring replaces its identity, "+
				"credential and paired browsers. Rerun with --force to overwrite", dir, strings.Join(there, ", "))
		}
	}
	files := map[string][]byte{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			return err
		}
		b, err := io.ReadAll(io.LimitReader(rc, maxFile+1))
		rc.Close()
		if err != nil {
			return fmt.Errorf("%s: %s: %w", path, f.Name, err)
		}
		if len(b) > maxFile {
			return fmt.Errorf("%s: %s is too big for a gateway backup", path, f.Name)
		}
		files[f.Name] = b
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	for n, b := range files {
		p := filepath.Join(dir, n)
		if err := os.WriteFile(p, b, 0o600); err != nil {
			return err
		}
		if err := os.Chmod(p, 0o600); err != nil { // WriteFile keeps an existing file's mode
			return err
		}
	}
	return nil
}
