package history

import "time"

// HealthPath is the gateway API's health history (any household member).
const HealthPath = "/streamiq/health"

// HealthRow is one recorded health row as GET /streamiq/health answers it. Null = not measured.
type HealthRow struct {
	At                time.Time `json:"at"`
	JellyfinReachable *bool     `json:"jellyfinReachable"`
	JellyfinVersion   *string   `json:"jellyfinVersion"`
	GatewayVersion    *string   `json:"gatewayVersion"`
	Tunnels           *int      `json:"tunnels"`
	Transcodes        *int      `json:"transcodes"`
	CPU               *float64  `json:"cpu"`
	Memory            *float64  `json:"memory"`
}

// TunnelsPath is the tunnel history; ?scope=household: every member's (admin only).
const TunnelsPath = "/streamiq/tunnels"

// SummaryPath is the per-user summary of the tunnel history (admin only).
const SummaryPath = "/streamiq/tunnels/summary"

// Tunnel is one ended tunnel to this gateway, a line of the history and a row of
// GET /streamiq/tunnels.
type Tunnel struct {
	ID string `json:"id"` // the broker session
	// GatewayID: the enrollment that wrote it; a re-enrolled gateway (maybe another
	// household) answers none of its earlier lines.
	GatewayID string    `json:"gatewayId"`
	CreatedAt time.Time `json:"createdAt"`
	EndedAt   time.Time `json:"endedAt"`
	// UserID: stored on every line, answered in the household scope only.
	UserID         string  `json:"userId,omitempty"`
	Relay          bool    `json:"relay"`
	IPv6           bool    `json:"ipv6"`
	BytesSent      uint64  `json:"bytesSent"`
	BytesReceived  uint64  `json:"bytesReceived"`
	ThroughputKbps *int    `json:"throughputKbps"` // null = none measured
	Failure        *string `json:"failure"`        // null = it came up and passed auth
	Use            *string `json:"use"`            // null = no request served
	ActiveMs       *int64  `json:"activeMs"`       // null = no request served
}

// Summary is a row of GET /streamiq/tunnels/summary: one user's last TunnelDays.
type Summary struct {
	UserID  string `json:"userId"`
	Tunnels int    `json:"tunnels"`
	// Hidden: management or diagnostics that didn't fail, the rows Activity hides by default.
	Hidden int `json:"hidden"`
	Failed int `json:"failed"`
	// RelayedBytes: both directions of every relayed tunnel, whatever its use: what the relay costs.
	RelayedBytes uint64 `json:"relayedBytes"`
}
