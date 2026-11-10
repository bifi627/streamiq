package jellyfin

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
)

// Image is the Jellyfin image this release pins in jellyfin-compose.yml
// (TestPinsMatchTested); `gateway jellyfin upgrade` writes it.
const Image = "jellyfin/jellyfin:12.4.20261026-211555"

// ComposeFile is the release asset `gateway jellyfin up` downloads.
const ComposeFile = "jellyfin-compose.yml"

var imageLine = regexp.MustCompile(`(?m)^(\s*image:\s*)jellyfin/jellyfin:\S+`)

// Pin points the jellyfin/jellyfin image line at Image and leaves every other
// byte alone (the file is the user's). changed is false if it already matches.
func Pin(b []byte) (out []byte, changed bool, err error) {
	m := imageLine.FindSubmatch(b)
	if m == nil {
		return nil, false, errors.New("no `image: jellyfin/jellyfin:…` line; edit the image by hand")
	}
	if string(m[0]) == string(m[1])+Image {
		return b, false, nil
	}
	return imageLine.ReplaceAll(b, []byte("${1}"+Image)), true, nil
}

// Upgrade pins file to Image and restarts Jellyfin; false if it was already on it.
func Upgrade(ctx context.Context, file string) (bool, error) {
	b, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("no %s: run `gateway jellyfin up` first", file)
	}
	if err != nil {
		return false, err
	}
	out, changed, err := Pin(b)
	if err != nil || !changed {
		return false, err
	}
	if err := os.WriteFile(file, out, 0o644); err != nil {
		return false, err
	}
	return true, Compose(ctx, file, "up", "-d")
}

// Compose runs `docker compose -f file args…` with its output on the terminal.
func Compose(ctx context.Context, file string, args ...string) error {
	if _, err := exec.LookPath("docker"); err != nil {
		return errors.New("Docker not found: install Docker Desktop (Windows, macOS) or Docker Engine (Linux), then retry")
	}
	if exec.CommandContext(ctx, "docker", "compose", "version").Run() != nil {
		return errors.New("Docker Compose v2 (`docker compose`) not found: update Docker Desktop, or install the docker-compose-plugin package")
	}
	cmd := exec.CommandContext(ctx, "docker", append([]string{"compose", "-f", file}, args...)...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Run()
}
