package main

import (
	"context"
	"log"
	"net/http"
	"runtime"
	"time"

	"streamiq/gateway/internal/history"
	"streamiq/gateway/internal/host"
	"streamiq/gateway/internal/jellyfin"
	"streamiq/gateway/internal/pairing"
	"streamiq/gateway/internal/tunnel"
	"streamiq/gateway/internal/update"
)

// box reads the gateway box's state: GET /streamiq/status live and the health history.
type box struct {
	setup   *jellyfin.Setup
	compose string
	sess    interface{ Active() int }
	load    *host.Sampler
}

// record adds the box's health to the history every 30 s: the history stays on the gateway.
func (b *box) record(ctx context.Context, h *history.Health) {
	// Before Jellyfin's first probe the view says unreachable: a restart would record a
	// "Jellyfin down" that never was. A Jellyfin really down is recorded after 30 s.
	for i := 0; i < 30 && !b.setup.View().Reachable; i++ {
		if !sleep(ctx, time.Second) {
			return
		}
	}
	for {
		if err := h.Record(time.Now(), b.health(ctx)); err != nil {
			log.Printf("gateway: health history: %v", err)
		}
		if !sleep(ctx, 30*time.Second) {
			return
		}
	}
}

// sleep waits d; false when ctx ended first.
func sleep(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

func (b *box) health(ctx context.Context) history.Sample {
	v := b.setup.View()
	l := b.load.Load()
	h := history.Sample{
		Jellyfin: history.Jellyfin{Reachable: v.Reachable, Version: v.Version},
		OS:       runtime.GOOS, Arch: runtime.GOARCH, Transcoding: v.Transcoding(),
		Offline: jellyfin.Offline(b.compose), Tunnels: b.sess.Active(), CPU: l.CPU,
	}
	if m := l.Memory; m != nil && m.Total > 0 {
		pct := 100 * float64(m.Used) / float64(m.Total)
		h.Memory = &pct
	}
	if !v.Reachable { // the recording waits on it: no sign-in into a Jellyfin that's down
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
		tunnel.JSON(w, http.StatusOK, Status{
			Transcoding: v.Transcoding(),
			OS:          runtime.GOOS, Arch: runtime.GOARCH, StartedAt: started,
			Jellyfin: JellyfinStatus{
				Reachable: v.Reachable, Version: v.Version, Untested: v.Untested, Token: v.Token(),
				Offline: jellyfin.Offline(b.compose),
			},
			PairedClients: len(store.Paired()), ActiveSessions: b.sess.Active(),
			Viewer:       b.setup.ViewerState(tunnel.SessionOf(r).User),
			RemoteUpdate: remoteUpdate(remote),
			Host:         b.load.Load(),
		})
	})
}
