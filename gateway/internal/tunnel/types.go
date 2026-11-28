package tunnel

// The bodies of the gateway API endpoints this package serves (docs/protocol.md,
// "Gateway API"), types only: scripts/gen-types.sh makes the web app's TypeScript
// from this file.

// Throughput is POST ThroughputPath's body: what the browser measured, gateway →
// client. Missing, zero or negative = none.
type Throughput struct {
	ThroughputKbps int `json:"throughputKbps"`
}

// Playback is POST PlaybackPath's body: one playback's quality, as its browser measured it.
type Playback struct {
	ItemID        string `json:"itemId"`
	Codec         string `json:"codec"`
	Width         int    `json:"width"`
	Height        int    `json:"height"`
	Quality       string `json:"quality"` // the picked one: Auto | Source | Raw | a rung (1080p …)
	Remux         bool   `json:"remux"`   // false = video transcoded
	PlayedSec     int    `json:"playedSec"`
	DroppedFrames int    `json:"droppedFrames"`
	TotalFrames   int    `json:"totalFrames"`
	WorstStallMs  int    `json:"worstStallMs"` // the longest main-thread stall
	Waits         int    `json:"waits"`        // <video> waiting events
}

// Route is GET RoutePath.
type Route struct {
	Route string `json:"route" tstype:"'relay' | 'lan' | 'direct'"`
}
