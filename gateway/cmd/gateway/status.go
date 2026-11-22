package main

// GET /streamiq/status (box.status), types only: scripts/gen-types.sh makes the
// web app's TypeScript from this file.

import (
	"time"

	"streamiq/gateway/internal/host"
	"streamiq/gateway/internal/jellyfin"
)

// Status counts clients and tunnels only: no client names (no PII).
type Status struct {
	Transcoding    string                `json:"transcoding"`
	OS             string                `json:"os"`
	Arch           string                `json:"arch"`
	StartedAt      time.Time             `json:"startedAt"`
	Jellyfin       JellyfinStatus        `json:"jellyfin"`
	PairedClients  int                   `json:"pairedClients"`
	ActiveSessions int                   `json:"activeSessions"`
	Viewer         jellyfin.ViewerStatus `json:"viewer"`                                // the calling session's
	RemoteUpdate   any                   `json:"remoteUpdate"   tstype:"true | string"` // the update button works, or why not
	Host           host.Load             `json:"host"`                                  // live only, never cached
	Telemetry      string                `json:"telemetry"      tstype:"'off' | 'full'"`
}

type JellyfinStatus struct {
	Reachable bool   `json:"reachable"`
	Version   string `json:"version"`
	Untested  bool   `json:"untested"`
	Token     string `json:"token"             tstype:"'ok' | 'missing'"`
	Offline   string `json:"offline,omitempty" tstype:"'enforced' | 'allowed'"` // absent = no compose Jellyfin
}
