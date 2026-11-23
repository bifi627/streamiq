package tunnel

// The bodies of the gateway API endpoints this package serves (docs/protocol.md,
// "Gateway API"), types only: scripts/gen-types.sh makes the web app's TypeScript
// from this file.

// Throughput is POST ThroughputPath's body: what the browser measured, gateway →
// client. Missing, zero or negative = none.
type Throughput struct {
	ThroughputKbps int `json:"throughputKbps"`
}

// Route is GET RoutePath.
type Route struct {
	Route string `json:"route" tstype:"'relay' | 'lan' | 'direct'"`
}
