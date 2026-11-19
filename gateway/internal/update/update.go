// Package update tells the user when a newer gateway release exists, and on
// Windows `gateway update` downloads, verifies and swaps the binary (#117).
// Nothing updates in the background: the user runs `gateway update`, or an admin
// starts it from the web app (Remote, #312: Windows with the logon task). An
// update keeps the state and the binary it replaced in backups/ for
// `gateway rollback` (#296).
package update

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"
)

// LatestURL is GitHub's latest *non-prerelease* release (STREAMIQ_LATEST
// overrides it: the update test serves its own, #452). ponytail: assumes every release in the repo is a gateway release (tag gateway-vX.Y.Z); filter
// by tag prefix over /releases if the repo ever publishes other releases.
const LatestURL = "https://api.github.com/repos/bifi627/streamiq/releases/latest"

// Latest returns the newest release's version ("1.4.0"), or "" if the latest
// release isn't a gateway release.
func Latest(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("release check: HTTP %d", res.StatusCode)
	}
	var rel struct {
		Tag string `json:"tag_name"`
	}
	if err := json.NewDecoder(res.Body).Decode(&rel); err != nil {
		return "", err
	}
	v, ok := strings.CutPrefix(rel.Tag, "gateway-v")
	if !ok {
		return "", nil
	}
	return v, nil
}

// Newer reports whether version a is newer than b ("1.10.0" > "1.9.3").
// Prerelease suffixes ("-nightly.3") are ignored. Unparsable = not newer.
func Newer(a, b string) bool {
	pa, pb := parse(a), parse(b)
	if pa == nil || pb == nil {
		return false
	}
	for i := range 3 {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

func parse(v string) []int {
	v, _, _ = strings.Cut(v, "-")
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return nil
	}
	out := make([]int, 3)
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil
		}
		out[i] = n
	}
	return out
}

// DownloadURL is where release assets live (STREAMIQ_DOWNLOAD overrides it, as in the installers).
const DownloadURL = "https://github.com/bifi627/streamiq/releases/latest/download"

// Command is the one line the user runs to update on this OS.
func Command() string {
	if runtime.GOOS == "windows" {
		exe, err := os.Executable()
		if err != nil {
			exe = "gateway.exe"
		}
		return exe + " update"
	}
	return "curl -fsSL " + DownloadURL + "/install.sh | sh"
}

// Asset is this platform's release binary, as release-gateway.yml names it.
func Asset() string {
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	return "streamiq-gateway-" + runtime.GOOS + "-" + runtime.GOARCH + ext
}

// Download fetches dl/asset to dst and checks it against dl/SHA256SUMS, as the
// installers do. On a mismatch dst is removed and nothing else changes.
// ponytail: SHA256SUMS comes from the same release, so it catches corruption,
// not a compromised release; signing is #69.
func Download(ctx context.Context, dl, asset, dst string) error {
	want, err := sum(ctx, dl+"/SHA256SUMS", asset)
	if err != nil {
		return err
	}
	body, err := get(ctx, dl+"/"+asset)
	if err != nil {
		return err
	}
	defer body.Close()
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil && hex.EncodeToString(h.Sum(nil)) != want {
		err = fmt.Errorf("checksum mismatch for %s, not installing", asset)
	}
	if err != nil {
		os.Remove(dst)
	}
	return err
}

func sum(ctx context.Context, url, asset string) (string, error) {
	body, err := get(ctx, url)
	if err != nil {
		return "", err
	}
	defer body.Close()
	sc := bufio.NewScanner(body)
	for sc.Scan() { // sha256sum format: "<hex>  <name>" (or "<hex> *<name>")
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == asset {
			return strings.ToLower(f[0]), nil
		}
	}
	if err := sc.Err(); err != nil {
		return "", err
	}
	return "", fmt.Errorf("%s not in SHA256SUMS", asset)
}

func get(ctx context.Context, url string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		res.Body.Close()
		return nil, fmt.Errorf("download %s: HTTP %d", url, res.StatusCode)
	}
	return res.Body, nil
}

// Swap puts in at exe and moves exe to out (replacing a file there). Windows
// can't overwrite a running exe but can rename it. If the move-in fails, exe is
// put back. An update moves exe into its backup dir (#296); a rollback moves the
// kept binary in and the current one to exe.old (removed by the next update).
func Swap(exe, in, out string) error {
	if err := os.Remove(out); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove %s: %w", out, err)
	}
	if err := os.Rename(exe, out); err != nil {
		return err
	}
	if err := os.Rename(in, exe); err != nil {
		return errors.Join(err, os.Rename(out, exe))
	}
	return nil
}

// Backups is the install dir's folder of pre-update backups (#296): one dir per
// update, <time>-<version>, with the state backup (StateZip) and the binary that
// was replaced. Unencrypted secrets, like any gateway backup: 0700.
const (
	Backups  = "backups"
	StateZip = "state.zip"
	keep     = 3 // install.sh and install.ps1 keep as many
)

// BackupDir makes the dir for one update's backup of version. "" on an error: a
// dir that exists already is another update's, not this one's to clean up (#635).
func BackupDir(install, version string, now time.Time) (string, error) {
	d := filepath.Join(install, Backups, now.Format("20060102-150405")+"-"+version)
	if err := os.MkdirAll(filepath.Dir(d), 0o700); err != nil {
		return "", err
	}
	if err := os.Mkdir(d, 0o700); err != nil {
		return "", err
	}
	return d, nil
}

// Prune removes all but the newest keep backup dirs (names sort by time).
func Prune(install string) error {
	es, err := os.ReadDir(filepath.Join(install, Backups)) // sorted by name
	if errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	var dirs []string
	for _, e := range es {
		if e.IsDir() {
			dirs = append(dirs, e.Name())
		}
	}
	for _, d := range dirs[:max(0, len(dirs)-keep)] {
		if err := os.RemoveAll(filepath.Join(install, Backups, d)); err != nil {
			return err
		}
	}
	return nil
}

// Previous is the newest backup dir that holds both a binary named bin and its
// state backup, and the version it names ("1.4.0", or "unknown").
func Previous(install, bin string) (dir, version string, err error) {
	es, err := os.ReadDir(filepath.Join(install, Backups))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", "", err
	}
	for _, e := range slices.Backward(es) {
		d := filepath.Join(install, Backups, e.Name())
		_, e1 := os.Stat(filepath.Join(d, bin))
		_, e2 := os.Stat(filepath.Join(d, StateZip))
		if e.IsDir() && e1 == nil && e2 == nil {
			_, v, _ := strings.Cut(e.Name()[min(len(e.Name()), len("20060102-150405")):], "-")
			return d, v, nil
		}
	}
	return "", "", fmt.Errorf(
		"no previous version kept in %s (it is made by an update, since #296)",
		filepath.Join(install, Backups),
	)
}
