package tunnel

// The bodies of the gateway API endpoints this package serves (docs/protocol.md,
// "Gateway API"), types only: scripts/gen-types.sh makes the web app's TypeScript
// from this file.

// Route is GET RoutePath.
type Route struct {
	Route string `json:"route" tstype:"'relay' | 'lan' | 'direct'"`
}
