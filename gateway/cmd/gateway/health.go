package main

import (
	"context"
	"net/http"
	"runtime"
	"time"

	"streamiq/gateway/internal/host"
	"streamiq/gateway/internal/jellyfin"
	"streamiq/gateway/internal/pairing"
	"streamiq/gateway/internal/telemetry"
	"streamiq/gateway/internal/tunnel"
	"streamiq/gateway/internal/update"
)

// box reads the gateway box's state: GET /streamiq/status live, the heartbeat's
// health at telemetry full.
type box struct {
	dir     string // state dir
	setup   *jellyfin.Setup
	compose string
	sess    interface{ Active() int }
	load    *host.Sampler
}

// beat is the heartbeat's telemetry level and the health it allows, read now:
// a changed state/telemetry counts from the next heartbeat.
func (b *box) beat(ctx context.Context) (string, any) {
	level := telemetry.Read(b.dir)
	if level != telemetry.Full {
		return level, nil
	}
	return level, b.health(ctx)
}

func (b *box) health(ctx context.Context) telemetry.Health {
	v := b.setup.View()
	l := b.load.Load(b.compose)
	h := telemetry.Health{
		Jellyfin: telemetry.Jellyfin{Reachable: v.Reachable, Version: v.Version},
		OS:       runtime.GOOS, Arch: runtime.GOARCH, Transcoding: v.Transcoding(),
		Offline: jellyfin.Offline(b.compose), Tunnels: b.sess.Active(), CPU: l.CPU,
	}
	if m := l.Memory; m != nil && m.Total > 0 {
		pct := 100 * float64(m.Used) / float64(m.Total)
		h.Memory = &pct
	}
	if !v.Reachable { // the heartbeat waits on it: no sign-in into a Jellyfin that's down
		return h
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if n, err := b.setup.Transcodes(ctx); err == nil {
		h.Transcodes = &n
	}
	return h
}

// status is GET /streamiq/status.
func (b *box) status(started time.Time, store *pairing.Store, remote *update.Remote) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		v := b.setup.View()
		jfs := map[string]any{
			"reachable": v.Reachable,
			"version":   v.Version,
			"untested":  v.Untested,
			"token":     v.Token(),
		}
		if o := jellyfin.Offline(b.compose); o != "" { // no compose Jellyfin: no field
			jfs["offline"] = o
		}
		tunnel.JSON(w, http.StatusOK, map[string]any{
			"transcoding": v.Transcoding(),
			"os":          runtime.GOOS, "arch": runtime.GOARCH, "startedAt": started,
			"jellyfin": jfs,
			// Counts only: no client names (no PII).
			"pairedClients": len(store.Paired()), "activeSessions": b.sess.Active(),
			"viewer":       b.setup.ViewerState(tunnel.SessionOf(r).User),
			"remoteUpdate": remoteUpdate(remote),
			"host":         b.load.Load(b.compose),
			"telemetry":    telemetry.Read(b.dir),
		})
	})
}
