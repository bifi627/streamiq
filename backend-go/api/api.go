// Package api holds the REST bodies of the ported endpoints: the Go handlers send
// them and tygo turns them into the web app's TypeScript.
package api

import "time"

// Me is GET /api/me.
type Me struct {
	UserID      string      `json:"userId"`
	TenantID    *string     `json:"tenantId"` // the household this request acts in; null = in none
	Memberships []Household `json:"memberships"`
}

// Household is one of the user's households, oldest first.
type Household struct {
	ID   string  `json:"id"`
	Name *string `json:"name"`
	Role string  `json:"role" tstype:"'admin' | 'member'"`
}

// Gateway is one row of GET /api/gateways.
type Gateway struct {
	ID              string     `json:"id"`
	Name            *string    `json:"name"`
	LastSeenAt      *time.Time `json:"lastSeenAt"`
	LanURL          *string    `json:"lanUrl"`
	Version         *string    `json:"version"`
	Update          *string    `json:"update"`
	Telemetry       *string    `json:"telemetry" tstype:"'off' | 'full' | null"`
	Online          bool       `json:"online"`
	UpgradeRequired bool       `json:"upgradeRequired"`
}

// TunnelThroughput is the body of PATCH /api/tunnels/{id}.
type TunnelThroughput struct {
	ThroughputKbps *int `json:"throughputKbps"`
}
