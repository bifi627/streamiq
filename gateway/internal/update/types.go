package update

// The replies of Path (gateway API), types only: scripts/gen-types.sh makes the
// web app's TypeScript from this file.

// Started is the 202: the version the gateway installs before it goes down.
type Started struct {
	Version string `json:"version"`
}

// Refused is the 409: why the gateway won't update itself, one of the Refused* codes
// (also /streamiq/status's remoteUpdate); the web app has the text per code.
type Refused struct {
	Reason string `json:"reason"`
}

const (
	RefusedUnsupported = "unsupported" // remote update works on Windows only so far
	RefusedDevBuild    = "dev build"
	RefusedRunning     = "running"    // an update is already running
	RefusedUpToDate    = "up to date" // no newer release
	RefusedNoTask      = "no task"    // no logon task would start the gateway again
)
