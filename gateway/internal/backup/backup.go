// Package backup packs the gateway's state dir into one zip and unpacks it
// again (`gateway backup` / `gateway restore`, #52), plus the install dir's
// jellyfin-compose.yml (#297). The zip is not encrypted:
// whoever has it can pose as the gateway (docs/install.md).
package backup

import (
	"archive/zip"
	"encoding/json"
	"errors"
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

// ComposeEntry is the compose file's name in the zip. State entries are flat,
// so the prefix keeps it from ever being taken for (or written as) a state file.
const ComposeEntry = "install/jellyfin-compose.yml"

// What Restore did with the compose file.
const (
	ComposeNone    = ""        // the backup has none
	ComposeWritten = "written" // put into the install dir
	ComposeKept    = "kept"    // the install dir already had one: left as it is
)

// maxFile caps one unpacked file: the real ones are a few KB.
const maxFile = 10 << 20

// FileName is the default backup name: streamiq-gateway-<name>-<date>-<time>.zip.
func FileName(dir string, now time.Time) string {
	var st struct{ Name string }
	b, _ := os.ReadFile(filepath.Join(dir, "gateway.json"))
	_ = json.Unmarshal(b, &st)
	name := strings.Trim(regexp.MustCompile(`[^A-Za-z0-9._-]+`).ReplaceAllString(st.Name, "-"), "-.")
	if name != "" {
		name += "-"
	}
	return "streamiq-gateway-" + name + now.Format("2006-01-02-150405") + ".zip"
}

// Write zips every regular file in dir except skip, and compose (the managed
// Jellyfin's compose file) if it exists. It only reads, so it works while the
// gateway runs.
func Write(dir, compose string, w io.Writer) error {
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
	if b, err := os.ReadFile(compose); err == nil {
		f, err := zw.Create(ComposeEntry)
		if err != nil {
			return err
		}
		if _, err := f.Write(b); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return zw.Close()
}

// Restore unpacks the zip at path into dir, and its compose file to compose
// unless a file is there already (never replaced, not even with force: it is
// the user's, their media folders are in it). It checks the whole zip before it
// writes anything, and refuses to replace an existing identity unless force.
// It returns what it did with the compose file (Compose*).
func Restore(path, dir, compose string, force bool) (string, error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return ComposeNone, err
	}
	defer zr.Close()
	var names []string
	for _, f := range zr.File {
		n := f.Name
		if n == ComposeEntry {
			continue
		}
		// Flat names only: no directories, no zip-slip.
		if n == "." || !filepath.IsLocal(n) || filepath.Base(n) != n || strings.ContainsAny(n, `/\:`) || f.FileInfo().IsDir() {
			return ComposeNone, fmt.Errorf("%s: not a gateway backup (entry %q)", path, n)
		}
		names = append(names, n)
	}
	for _, r := range required {
		if !slices.Contains(names, r) {
			return ComposeNone, fmt.Errorf("%s: not a gateway backup (no %s)", path, r)
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
			return ComposeNone, fmt.Errorf("%s already holds a gateway (%s): restoring replaces its identity, "+
				"credential and paired browsers. Rerun with --force to overwrite", dir, strings.Join(there, ", "))
		}
	}
	files := map[string][]byte{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			return ComposeNone, err
		}
		b, err := io.ReadAll(io.LimitReader(rc, maxFile+1))
		rc.Close()
		if err != nil {
			return ComposeNone, fmt.Errorf("%s: %s: %w", path, f.Name, err)
		}
		if len(b) > maxFile {
			return ComposeNone, fmt.Errorf("%s: %s is too big for a gateway backup", path, f.Name)
		}
		files[f.Name] = b
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ComposeNone, err
	}
	// Every write goes through root: the OS refuses a path that leaves dir (.., symlinks),
	// a second guard behind the name check above.
	root, err := os.OpenRoot(dir)
	if err != nil {
		return ComposeNone, err
	}
	defer root.Close()
	if force { // the old gateway's files the backup doesn't have (e.g. its allowlist.json) go
		old, err := os.ReadDir(dir)
		if err != nil {
			return ComposeNone, err
		}
		for _, e := range old {
			if _, ok := files[e.Name()]; !ok && e.Type().IsRegular() && !slices.Contains(skip, e.Name()) {
				if err := root.Remove(e.Name()); err != nil {
					return ComposeNone, err
				}
			}
		}
	}
	c, hasCompose := files[ComposeEntry]
	delete(files, ComposeEntry)
	for n, b := range files {
		if err := root.WriteFile(n, b, 0o600); err != nil {
			return ComposeNone, err
		}
		if err := root.Chmod(n, 0o600); err != nil { // WriteFile keeps an existing file's mode
			return ComposeNone, err
		}
	}
	if !hasCompose {
		return ComposeNone, nil
	}
	f, err := os.OpenFile(compose, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644) // O_EXCL: never over theirs
	if errors.Is(err, os.ErrExist) {
		return ComposeKept, nil
	} else if err != nil {
		return ComposeNone, err
	}
	_, err = f.Write(c)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return ComposeNone, err
	}
	return ComposeWritten, nil
}
