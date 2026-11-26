package jellyfin

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"text/tabwriter"
)

// The Docker side of `gateway jellyfin folder`; tests swap them.
var (
	jellyfinRunning = func(ctx context.Context, file string) bool {
		out, err := exec.CommandContext(ctx, "docker", "compose", "-f", file, "ps", "-q", "--status", "running", "jellyfin").
			Output()
		return err == nil && len(bytes.TrimSpace(out)) > 0
	}
	recreate = func(ctx context.Context, file string) error { return Compose(ctx, file, "up", "-d") }
)

// FolderIO is what a `gateway jellyfin folder` command reads and writes.
type FolderIO struct {
	File string // jellyfin-compose.yml
	Yes  bool   // no confirm
	In   io.Reader
	Out  io.Writer
}

func (f FolderIO) read() ([]byte, error) {
	b, err := os.ReadFile(f.File)
	if errors.Is(err, os.ErrNotExist) {
		return nil, errors.New(
			"`gateway jellyfin folder` needs the Jellyfin from jellyfin-compose.yml (`gateway jellyfin up`); " +
				"mount folders into another Jellyfin the way it runs",
		)
	}
	return b, err
}

func (f FolderIO) shape(err error) error { return fmt.Errorf("%s is unchanged: %w", f.File, err) }

// FolderList is `gateway jellyfin folder list`.
func FolderList(f FolderIO) error {
	b, err := f.read()
	if err != nil {
		return err
	}
	ms, err := Mounts(b)
	if err != nil {
		return fmt.Errorf("%s: %w", f.File, err)
	}
	if len(ms) == 0 {
		fmt.Fprintf(f.Out, "No folder is mounted under %s (`gateway jellyfin folder add <path>`).\n", MediaDir)
		return nil
	}
	w := tabwriter.NewWriter(f.Out, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "FOLDER\tIN JELLYFIN")
	for _, m := range ms {
		fmt.Fprintf(w, "%s\t%s", m.Source, m.Target)
		if m.ReadWrite {
			fmt.Fprint(w, "\tread-write")
		}
		fmt.Fprintln(w)
	}
	return w.Flush()
}

// FolderAdd is `gateway jellyfin folder add <path> [--as <name>]`.
func FolderAdd(ctx context.Context, f FolderIO, path, name string) error {
	b, err := f.read()
	if err != nil {
		return err
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if fi, serr := os.Stat(abs); errors.Is(serr, os.ErrNotExist) {
		return fmt.Errorf("%s doesn't exist", abs)
	} else if serr != nil {
		return serr
	} else if !fi.IsDir() {
		return fmt.Errorf("%s is not a folder", abs)
	}
	nb, m, err := AddMount(b, filepath.Dir(f.File), abs, name)
	if errors.Is(err, errShape) {
		return f.shape(err)
	}
	if err != nil {
		return err
	}
	what := fmt.Sprintf("Mount %s read-only into Jellyfin at %s.\n", m.Source, m.Target)
	return f.apply(ctx, b, nb, what, fmt.Sprintf(
		"Mounted: pick %s as a library folder in Jellyfin's Dashboard.", m.Target))
}

// FolderRemove is `gateway jellyfin folder remove <path|/media/name>`.
func FolderRemove(ctx context.Context, f FolderIO, which string) error {
	b, err := f.read()
	if err != nil {
		return err
	}
	path := which
	if !strings.HasPrefix(which, MediaDir) {
		if path, err = filepath.Abs(which); err != nil {
			return err
		}
	}
	nb, removed, err := RemoveMount(b, filepath.Dir(f.File), path)
	if errors.Is(err, errShape) {
		return f.shape(err)
	}
	if err != nil {
		return err
	}
	var what strings.Builder
	for _, m := range removed {
		fmt.Fprintf(&what, "Unmount %s from %s.\n", m.Source, m.Target)
		fmt.Fprintf(&what, "Libraries using %s lose its titles until it is mounted again.\n", m.Target)
	}
	what.WriteString("No file is deleted.\n")
	return f.apply(ctx, b, nb, what.String(), "Unmounted.")
}

// apply says what happens, asks, writes the file and recreates a running
// Jellyfin from it (the old file back if that fails).
func (f FolderIO) apply(ctx context.Context, old, b []byte, what, done string) error {
	running := jellyfinRunning(ctx, f.File)
	fmt.Fprint(f.Out, what)
	if running {
		fmt.Fprintln(f.Out, "Jellyfin restarts: streams playing now stop.")
	} else {
		fmt.Fprintln(f.Out, "Jellyfin isn't running: this applies at the next `gateway jellyfin up`.")
	}
	if !f.Yes {
		fmt.Fprint(f.Out, "Go on? [y/N] ")
		a, _ := bufio.NewReader(f.In).ReadString('\n')
		if a = strings.ToLower(strings.TrimSpace(a)); a != "y" && a != "yes" {
			fmt.Fprintln(f.Out, "Nothing changed.")
			return nil
		}
	}
	if err := os.WriteFile(f.File, b, 0o644); err != nil {
		return err
	}
	if running {
		if err := recreate(ctx, f.File); err != nil {
			return errors.Join(err, os.WriteFile(f.File, old, 0o644))
		}
	}
	fmt.Fprintln(f.Out, done)
	return nil
}
