package telemetry

// The body of Path (gateway API), types only: scripts/gen-types.sh makes the web
// app's TypeScript from this file.

// Level is POST Path's body and its reply.
type Level struct {
	Level string `json:"level" tstype:"'off' | 'full'"`
}
