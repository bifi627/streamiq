// Package backup packs the gateway's state dir into one zip and unpacks it
// again (`gateway backup` / `gateway restore`, #52), plus the install dir's
// jellyfin-compose.yml (#297) and Jellyfin's own backup archive (#298). The zip is not encrypted:
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

// JellyfinEntry is the managed Jellyfin's backup archive (#298), prefixed like
// ComposeEntry. Restore never unpacks it: `gateway jellyfin restore` does (ExtractJellyfin).
const JellyfinEntry = "install/jellyfin-backup.zip"

// maxJellyfin caps the Jellyfin archive (database only: no images, no trickplay).
var maxJellyfin int64 = 8 << 30 // a var for the test

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

// Write zips every regular file in dir except skip, compose (the managed
// Jellyfin's compose file) if it exists, and jellyfin (Jellyfin's backup
// archive) unless "". It only reads, so it works while the gateway runs.
func Write(dir, compose, jellyfin string, w io.Writer) error { //nolint:gocyclo // #544: split there
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
	if jellyfin != "" {
		src, err := os.Open(jellyfin)
		if err != nil {
			return err
		}
		defer src.Close()
		f, err := zw.CreateHeader(&zip.FileHeader{Name: JellyfinEntry, Method: zip.Store}) // a zip already
		if err != nil {
			return err
		}
		if _, err := io.Copy(f, src); err != nil {
			return err
		}
	}
	return zw.Close()
}

// Restore unpacks the zip at path into dir, and its compose file to compose
// unless a file is there already (never replaced, not even with force: it is
// the user's, their media folders are in it). It checks the whole zip before it
// writes anything, and refuses to replace an existing identity unless force.
// It returns what it did with the compose file (Compose*).
func Restore(path, dir, compose string, force bool) (string, error) { //nolint:gocyclo // #544: split there
	zr, err := zip.OpenReader(path)
	if err != nil {
		return ComposeNone, err
	}
	defer zr.Close()
	var names []string
	for _, f := range zr.File {
		n := f.Name
		if n == ComposeEntry || n == JellyfinEntry {
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
		if f.Name == JellyfinEntry { // never into RAM or state/
			continue
		}
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
		os.Remove(compose) // a partial one would be "kept" by every later restore
		return ComposeNone, err
	}
	return ComposeWritten, nil
}

// ErrNoJellyfin: the backup holds no Jellyfin data.
var ErrNoJellyfin = errors.New("this backup has no Jellyfin data (the gateway skipped Jellyfin when it was made; `gateway backup` says why)")

// ExtractJellyfin streams the backup's Jellyfin archive into dst (a new file)
// and returns the backup's jellyfin.json, the login that goes with it.
func ExtractJellyfin(path, dst string) (creds []byte, err error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	var jf, cf *zip.File
	for _, f := range zr.File {
		switch f.Name {
		case JellyfinEntry:
			jf = f
		case "jellyfin.json":
			cf = f
		}
	}
	if jf == nil || cf == nil {
		return nil, ErrNoJellyfin
	}
	rc, err := cf.Open()
	if err != nil {
		return nil, err
	}
	creds, err = io.ReadAll(io.LimitReader(rc, maxFile))
	rc.Close()
	if err != nil {
		return nil, err
	}
	rc, err = jf.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	n, err := io.Copy(out, io.LimitReader(rc, maxJellyfin+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil && n > maxJellyfin {
		err = fmt.Errorf("%s: %s is too big", path, JellyfinEntry)
	}
	if err != nil {
		os.Remove(dst)
		return nil, err
	}
	return creds, nil
}
