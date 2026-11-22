package onboarding

// The body of NamePath (gateway API), types only: scripts/gen-types.sh makes the
// web app's TypeScript from this file.

// Name is POST NamePath's body and its reply (the name as stored).
type Name struct {
	Name string `json:"name"`
}
