// Package backup packs the gateway's state dir into one zip and unpacks it
// again (`gateway backup` / `gateway restore`, #52), plus the install dir's
// jellyfin-compose.yml (#297) and Jellyfin's own backup archive (#298). The zip is not encrypted:
// whoever has it can pose as the gateway (docs/install.md).
package backup

import (
	"archive/zip"
	"bytes"
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

// maxTotal caps all unpacked entries together, so a zip of many maxFile
// entries can't fill RAM.
const maxTotal = 2 * maxFile

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
func Write(dir, compose, jellyfin string, w io.Writer) error {
	zw := zip.NewWriter(w)
	if err := zipState(zw, dir); err != nil {
		return err
	}
	if err := zipCompose(zw, compose); err != nil {
		return err
	}
	if err := zipJellyfin(zw, jellyfin); err != nil {
		return err
	}
	return zw.Close()
}

// zipState adds every regular file in dir except skip, each under its own name,
// and fails on a cut-short JSON file (checkJSON) or a dir without the required
// identity files.
func zipState(zw *zip.Writer, dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	have := 0
	for _, e := range entries {
		if !e.Type().IsRegular() || slices.Contains(skip, e.Name()) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return err
		}
		if err := checkJSON(e.Name(), b); err != nil {
			return err
		}
		if err := zipBytes(zw, e.Name(), b); err != nil {
			return err
		}
		if slices.Contains(required, e.Name()) {
			have++
		}
	}
	if have != len(required) {
		return fmt.Errorf("%s has no gateway identity (%s): nothing to back up", dir, strings.Join(required, ", "))
	}
	return nil
}

// checkJSON refuses a .json file that isn't valid JSON: the gateway rewrites
// its JSON files in place, so a read mid-write is cut short.
func checkJSON(name string, b []byte) error {
	if strings.HasSuffix(name, ".json") && !json.Valid(b) {
		return fmt.Errorf("%s was being written: run the backup again", name)
	}
	return nil
}

// zipBytes adds b to zw as the entry name.
func zipBytes(zw *zip.Writer, name string, b []byte) error {
	f, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = f.Write(b)
	return err
}

// zipCompose adds the compose file as ComposeEntry, or nothing if it doesn't exist.
func zipCompose(zw *zip.Writer, compose string) error {
	b, err := os.ReadFile(compose)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	return zipBytes(zw, ComposeEntry, b)
}

// zipJellyfin streams the Jellyfin archive in as JellyfinEntry, stored (it is a
// zip already); nothing if jellyfin is "".
func zipJellyfin(zw *zip.Writer, jellyfin string) error {
	if jellyfin == "" {
		return nil
	}
	src, err := os.Open(jellyfin)
	if err != nil {
		return err
	}
	defer src.Close()
	f, err := zw.CreateHeader(&zip.FileHeader{Name: JellyfinEntry, Method: zip.Store})
	if err != nil {
		return err
	}
	_, err = io.Copy(f, src)
	return err
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
	if err := checkEntries(path, zr.File); err != nil {
		return ComposeNone, err
	}
	if !force {
		if err := checkNoIdentity(dir); err != nil {
			return ComposeNone, err
		}
	}
	files, err := readEntries(path, zr.File)
	if err != nil {
		return ComposeNone, err
	}
	// The compose file first: it is the step that fails on a bad install dir, and
	// failing it must leave the state dir untouched (#592).
	did := ComposeNone
	if c, ok := files[ComposeEntry]; ok {
		delete(files, ComposeEntry)
		if did, err = writeCompose(compose, bytes.NewReader(c)); err != nil {
			return ComposeNone, err
		}
	}
	if err := restoreState(dir, files, force); err != nil {
		if did == ComposeWritten {
			os.Remove(compose) // ours: a rerun would otherwise keep it as the user's
		}
		return ComposeNone, err
	}
	return did, nil
}

// restoreState writes files into dir; with force it first removes the old
// gateway's files the backup doesn't have.
func restoreState(dir string, files map[string][]byte, force bool) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	// Every write goes through root: the OS refuses a path that leaves dir (.., symlinks),
	// a second guard behind checkEntries.
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer root.Close()
	if force {
		old, err := stale(dir, files)
		if err != nil {
			return err
		}
		if err := removeAll(root, old); err != nil {
			return err
		}
	}
	return writeState(root, files)
}

// checkEntries refuses a zip that isn't a gateway backup: every entry but
// ComposeEntry and JellyfinEntry must be a flat file name (no directories, no
// zip-slip), and every required file must be there.
func checkEntries(path string, zf []*zip.File) error {
	var names []string
	for _, f := range zf {
		n := f.Name
		if n == ComposeEntry || n == JellyfinEntry {
			continue
		}
		if n == "." || !filepath.IsLocal(n) || filepath.Base(n) != n || strings.ContainsAny(n, `/\:`) ||
			f.FileInfo().IsDir() {
			return fmt.Errorf("%s: not a gateway backup (entry %q)", path, n)
		}
		names = append(names, n)
	}
	for _, r := range required {
		if !slices.Contains(names, r) {
			return fmt.Errorf("%s: not a gateway backup (no %s)", path, r)
		}
	}
	return nil
}

// checkNoIdentity refuses a dir that already holds a required file: restoring
// there replaces a gateway, which takes --force (Restore skips this check).
func checkNoIdentity(dir string) error {
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
	return nil
}

// readEntries reads every entry but JellyfinEntry (never into RAM or state/)
// into a map by name, refusing an entry over maxFile and entries over maxTotal
// together.
func readEntries(path string, zf []*zip.File) (map[string][]byte, error) {
	files := map[string][]byte{}
	total := 0
	for _, f := range zf {
		if f.Name == JellyfinEntry {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		b, err := io.ReadAll(io.LimitReader(rc, maxFile+1))
		rc.Close()
		if err != nil {
			return nil, fmt.Errorf("%s: %s: %w", path, f.Name, err)
		}
		if len(b) > maxFile {
			return nil, fmt.Errorf("%s: %s is too big for a gateway backup", path, f.Name)
		}
		if total += len(b); total > maxTotal {
			return nil, fmt.Errorf("%s: too big for a gateway backup (over %d MiB unpacked)", path, maxTotal>>20)
		}
		files[f.Name] = b
	}
	return files, nil
}

// stale names the old gateway's files a forced restore removes (e.g. its
// allowlist.json): the regular files in dir the backup (files) doesn't have,
// except skip.
func stale(dir string, files map[string][]byte) ([]string, error) {
	old, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var gone []string
	for _, e := range old {
		if _, ok := files[e.Name()]; !ok && e.Type().IsRegular() && !slices.Contains(skip, e.Name()) {
			gone = append(gone, e.Name())
		}
	}
	return gone, nil
}

// removeAll removes names from root, stopping at the first error.
func removeAll(root *os.Root, names []string) error {
	for _, n := range names {
		if err := root.Remove(n); err != nil {
			return err
		}
	}
	return nil
}

// writeState writes files into root, each with mode 0600.
func writeState(root *os.Root, files map[string][]byte) error {
	for n, b := range files {
		if err := root.WriteFile(n, b, 0o600); err != nil {
			return err
		}
		if err := root.Chmod(n, 0o600); err != nil { // WriteFile keeps an existing file's mode
			return err
		}
	}
	return nil
}

// writeCompose writes src to compose unless a file is there already (ComposeKept:
// it is the user's). A failed write removes the partial file, which every
// later restore would otherwise keep.
func writeCompose(compose string, src io.Reader) (string, error) {
	f, err := os.OpenFile(compose, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644) // O_EXCL: never over theirs
	if errors.Is(err, os.ErrExist) {
		return ComposeKept, nil
	} else if err != nil {
		return ComposeNone, err
	}
	_, err = io.Copy(f, src)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(compose)
		return ComposeNone, err
	}
	return ComposeWritten, nil
}

// ErrNoJellyfin: the backup holds no Jellyfin data.
var ErrNoJellyfin = errors.New(
	"this backup has no Jellyfin data (the gateway skipped Jellyfin when it was made; `gateway backup` says why)",
)

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
