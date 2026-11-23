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
