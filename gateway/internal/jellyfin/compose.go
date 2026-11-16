package jellyfin

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
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

// Upgrade pins file to Image, moves a file from before #321 into the jail
// (Jail; a file it can't read is only pinned, with the manual steps printed),
// marks the NVIDIA block (MarkGPU) and restarts Jellyfin if anything changed.
func Upgrade(ctx context.Context, file string, out io.Writer) error {
	b, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("no %s: run `gateway jellyfin up` first", file)
	}
	if err != nil {
		return err
	}
	orig := b
	b, pinned, err := Pin(b)
	if err != nil {
		return err
	}
	jailed, migrated, err := Jail(b)
	if err == nil && migrated { // a shape Jail misread must not reach the user's file
		tmp := file + ".jail-check.yml" // same dir: relative mounts resolve the same
		if err = os.WriteFile(tmp, jailed, 0o644); err == nil {
			err = composeQuiet(ctx, tmp, "config", "--quiet")
			os.Remove(tmp)
		}
	}
	if err != nil {
		fmt.Fprintf(out, "Not moved into the offline jail: %v.\n%s", err, manualJail)
		jailed, migrated = b, false
	}
	jailed, marked := MarkGPU(jailed)
	if !pinned && !migrated && !marked {
		fmt.Fprintln(out, "Already on", Image)
		return nil
	}
	if err := os.WriteFile(file, jailed, 0o644); err != nil {
		return err
	}
	if err := Compose(ctx, file, "up", "-d"); err != nil {
		os.WriteFile(file, orig, 0o644) // the status reads the file: keep it saying what runs
		return err
	}
	fmt.Fprintln(out, "Jellyfin now runs", Image)
	if marked {
		fmt.Fprintln(out, "`gateway jellyfin gpu nvidia` can now switch the NVIDIA GPU on.")
	}
	if migrated {
		fmt.Fprintln(out, "Jellyfin is now offline: nothing leaves its container (`gateway jellyfin offline off` allows online lookups).")
	}
	return nil
}

// Compose runs `docker compose -f file args…` with its output on the terminal.
func Compose(ctx context.Context, file string, args ...string) error {
	if err := haveCompose(ctx); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "docker", append([]string{"compose", "-f", file}, args...)...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Run()
}

// composeQuiet is Compose with the output in the error only.
func composeQuiet(ctx context.Context, file string, args ...string) error {
	if err := haveCompose(ctx); err != nil {
		return err
	}
	out, err := exec.CommandContext(ctx, "docker", append([]string{"compose", "-f", file}, args...)...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker compose %s: %w: %s", args[0], err, bytes.TrimSpace(out))
	}
	return nil
}

func haveCompose(ctx context.Context) error {
	if _, err := exec.LookPath("docker"); err != nil {
		return errors.New("Docker not found: install Docker Desktop (Windows, macOS) or Docker Engine (Linux), then retry")
	}
	if exec.CommandContext(ctx, "docker", "compose", "version").Run() != nil {
		return errors.New("Docker Compose v2 (`docker compose`) not found: update Docker Desktop, or install the docker-compose-plugin package")
	}
	return nil
}
