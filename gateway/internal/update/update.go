// Package update tells the user when a newer gateway release exists, and on
// Windows `gateway update` downloads, verifies and swaps the binary (#117).
// Nothing updates in the background: only the user runs `gateway update`.
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
	"runtime"
	"strconv"
	"strings"
)

// LatestURL is GitHub's latest *non-prerelease* release. ponytail: assumes
// every release in the repo is a gateway release (tag gateway-vX.Y.Z); filter
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

// Swap puts newPath in place of exe. Windows can't overwrite a running exe but
// can rename it, so exe moves aside to exe.old first (removed by the next
// update, once nothing runs from it). If the move-in fails, exe is restored.
func Swap(exe, newPath string) error {
	old := exe + ".old"
	if err := os.Remove(old); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove %s: %w", old, err)
	}
	if err := os.Rename(exe, old); err != nil {
		return err
	}
	if err := os.Rename(newPath, exe); err != nil {
		os.Rename(old, exe)
		return err
	}
	return nil
}
