package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"streamiq/gateway/internal/history"
	"streamiq/gateway/internal/host"
	"streamiq/gateway/internal/jellyfin"
	"streamiq/gateway/internal/telemetry"
	"streamiq/gateway/internal/testwait"
	"streamiq/protocol"
)

type tunnels int

func (n tunnels) Active() int { return int(n) }

// off sends the level and no health; full the box's health, without a transcode
// count when Jellyfin's /Sessions can't be read (here: no admin), and nothing
// that names a person, a client, a title or a path.
func TestHeartbeatHealthPerLevel(t *testing.T) {
	jf := httptest.NewServer(http.NotFoundHandler())
	defer jf.Close()
	dir := t.TempDir()
	b := &box{dir: dir, setup: &jellyfin.Setup{Client: jf.Client(), URL: jf.URL, StateDir: dir},
		compose: dir + "/none.yml", sess: tunnels(2), load: &host.Sampler{}}
	if l, h := b.beat(context.Background()); l != telemetry.Off || h != nil {
		t.Fatalf("off: %q, %v", l, h)
	}
	if err := telemetry.Write(dir, telemetry.Full); err != nil {
		t.Fatal(err)
	}
	l, h := b.beat(context.Background())
	raw, _ := json.Marshal(h)
	var got map[string]any
	_ = json.Unmarshal(raw, &got)
	if l != telemetry.Full || got["tunnels"] != 2.0 || got["os"] == "" || got["transcoding"] != "unmanaged" {
		t.Fatalf("full: %q, %s", l, raw)
	}
	if _, ok := got["transcodes"]; ok {
		t.Fatalf("no admin: want no transcodes, got %s", raw)
	}
	if _, ok := got["offline"]; ok {
		t.Fatalf("no compose Jellyfin: want no offline, got %s", raw)
	}
	if regexp.MustCompile(`(?i)name|user|key|title|path|file`).Match(raw) {
		t.Fatalf("health names something it must not: %s", raw)
	}
}

// A restart with Jellyfin up records no "Jellyfin down" first: the first row waits
// for Jellyfin's first probe.
func TestTheFirstHistoryRowWaitsForTheJellyfinProbe(t *testing.T) {
	jf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/System/Info/Public" {
			http.NotFound(w, r)
			return
		}
		<-time.After(300 * time.Millisecond) // a Jellyfin slow to answer: the probe takes a moment
		_, _ = w.Write([]byte(`{"Version":"10.11.2","StartupWizardCompleted":true}`))
	}))
	defer jf.Close()
	dir := t.TempDir()
	setup := &jellyfin.Setup{Client: jf.Client(), URL: jf.URL, StateDir: dir, OnKey: func(string, string) {}}
	b := &box{dir: dir, setup: setup, compose: dir + "/none.yml", sess: tunnels(0), load: &host.Sampler{}}
	store := &history.Store{Dir: filepath.Join(dir, history.Dir), Kind: "health"}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go b.record(ctx, &history.Health{Store: store})
	go setup.Run(ctx)
	var rows []json.RawMessage
	testwait.Until(t, 10*time.Second, func() bool {
		rows, _ = history.Read[json.RawMessage](store)
		return len(rows) > 0
	}, "no history row")
	var first protocol.Health
	if json.Unmarshal(rows[0], &first) != nil || !first.Jellyfin.Reachable {
		t.Fatalf("first row %s, want Jellyfin reachable", rows)
	}
}
