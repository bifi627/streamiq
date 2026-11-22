// Package telemetry holds the gateway's telemetry level (state/telemetry): how
// much box health its heartbeat shares with the API. The file is the one truth;
// the CLI and the admin-only gateway API both write it.
package telemetry

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"streamiq/gateway/internal/tunnel"
)

// The levels. Off is the default (opt-in).
const (
	Off  = "off"
	Full = "full"
)

// Levels are the valid levels, Off first.
var Levels = []string{Off, Full}

// Sends says what a level shares, for the CLI and the local page.
func Sends(level string) string {
	if level == Full {
		return "Jellyfin reachable + version, OS/arch, hardware acceleration, offline jail, " +
			"active tunnels and transcodes, CPU % and memory % (no names, titles or paths)"
	}
	return "no health data, only liveness and the tunnel report"
}

func path(dir string) string { return filepath.Join(dir, "telemetry") }

var warned sync.Once

// Read is the level in dir. Missing = Off; unreadable or unknown content = Off
// too, logged once.
func Read(dir string) string {
	b, err := os.ReadFile(path(dir))
	if errors.Is(err, os.ErrNotExist) {
		return Off
	}
	l := strings.TrimSpace(string(b))
	if err == nil && (l == Off || l == Full) {
		return l
	}
	warned.Do(func() { log.Printf("gateway: %s: unreadable or unknown level (%q, %v): using off", path(dir), l, err) })
	return Off
}

// ErrBadLevel: not one of Levels.
var ErrBadLevel = errors.New("telemetry level must be off or full")

// Write stores level in dir, atomically.
func Write(dir, level string) error {
	if level != Off && level != Full {
		return ErrBadLevel
	}
	tmp := path(dir) + ".tmp"
	if err := os.WriteFile(tmp, []byte(level+"\n"), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path(dir))
}

// Path switches the level (gateway API, admin-only): POST {"level": "off"|"full"}
// → 200 {"level": stored}, anything else 400.
const Path = "/streamiq/telemetry"

// Switch is POST Path. Changed asks for an early heartbeat, so the API sees the
// new level at once.
type Switch struct {
	Dir     string
	Changed func()
}

func (s *Switch) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var in Level
	b, _ := io.ReadAll(r.Body)
	if json.Unmarshal(b, &in) != nil || (in.Level != Off && in.Level != Full) {
		tunnel.Fail(w, http.StatusBadRequest, fmt.Errorf("gateway API: telemetry: %w", ErrBadLevel))
		return
	}
	if err := Write(s.Dir, in.Level); err != nil {
		tunnel.Fail(w, http.StatusInternalServerError, fmt.Errorf("gateway API: telemetry: %w", err))
		return
	}
	log.Printf("gateway: telemetry %s (gateway API)", in.Level)
	s.Changed()
	tunnel.JSON(w, http.StatusOK, in)
}
