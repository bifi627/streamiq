package onboarding

// The bodies of NamePath and RelayPath (gateway API), types only: scripts/gen-types.sh makes the
// web app's TypeScript from this file.

// Name is POST NamePath's body and its reply (the name as stored).
type Name struct {
	Name string `json:"name"`
}

// Relay is POST RelayPath's body and its reply (the setting as stored); null = a bad body.
type Relay struct {
	Relay *bool `json:"relay"`
}
