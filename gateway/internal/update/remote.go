package update

import (
	"fmt"
	"net/http"
	"sync/atomic"

	"streamiq/gateway/internal/tunnel"
)

// Remote is an update started from the web app (gateway API POST
// /streamiq/update): only where the logon task brings the new binary back up.
type Remote struct {
	Version   string        // this binary's
	Supported bool          // service.Supported: Windows only for now; TODO(#119), TODO(#277)
	Newer     func() string // the newer release the daily check found, "" = none
	Task      func() bool   // service.Installed: nothing else would restart the gateway
	// Start runs the detached `gateway update`; wait returns once it has exited
	// (failed, or the swap stopped this gateway with it).
	Start   func() (wait func(), err error)
	running atomic.Bool
}

// Reason says why a remote update isn't possible now; "" = it is.
func (r *Remote) Reason() string {
	switch {
	case !r.Supported:
		return "remote update works on Windows only so far"
	case r.Version == "dev":
		return "dev build"
	case r.running.Load():
		return "an update is already running"
	case r.Newer() == "" || !Newer(r.Newer(), r.Version):
		return "already up to date"
	case !r.Task():
		return "no logon task, so nothing would start the gateway again after the update"
	}
	return ""
}

// Run starts the update and returns the version it installs, or why not
// (refused, nothing started). One at a time: a second Run while the first
// updater runs is refused.
func (r *Remote) Run() (target, refused string, err error) {
	if why := r.Reason(); why != "" {
		return "", why, nil
	}
	if !r.running.CompareAndSwap(false, true) {
		return "", "an update is already running", nil
	}
	target = r.Newer()
	wait, err := r.Start()
	if err != nil {
		r.running.Store(false)
		return "", "", err
	}
	go func() { wait(); r.running.Store(false) }()
	return target, "", nil
}

// Path starts a remote update (gateway API, admin-only): POST → 202
// {"version": target}, the gateway goes down for the swap right after; refused →
// 409 {"reason": "…"}.
const Path = "/streamiq/update"

// ServeHTTP is POST Path.
func (r *Remote) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	v, refused, err := r.Run()
	switch {
	case refused != "":
		tunnel.JSON(w, http.StatusConflict, Refused{refused})
	case err != nil:
		tunnel.Fail(w, http.StatusInternalServerError, fmt.Errorf("gateway API: update: %w", err))
	default:
		tunnel.JSON(w, http.StatusAccepted, Started{v})
	}
}
