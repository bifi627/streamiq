package update

// The replies of Path (gateway API), types only: scripts/gen-types.sh makes the
// web app's TypeScript from this file.

// Started is the 202: the version the gateway installs before it goes down.
type Started struct {
	Version string `json:"version"`
}

// Refused is the 409: why the gateway won't update itself.
type Refused struct {
	Reason string `json:"reason"`
}
