package jellyfin

// The gateway API's library bodies (docs/protocol.md), types only:
// scripts/gen-types.sh makes the web app's TypeScript from this file.

// Library is one library of GET /streamiq/libraries.
type Library struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// every type the library can hold has every metadata and image fetcher off
	Offline  bool   `json:"offline"`
	Extras   string `json:"extras"` // on | off | custom
	Scanning bool   `json:"scanning"`
	Progress int    `json:"progress"` // 0–100 while scanning
}

// LibraryID is the body of POST /streamiq/libraries/rescan.
type LibraryID struct {
	ID string `json:"id"`
}

// LibrarySwitch is the body of POST /streamiq/libraries/online and /extras.
type LibrarySwitch struct {
	ID string `json:"id"`
	On bool   `json:"on"`
}

// LibraryError is a failed library call's body: Jellyfin's error, or why the gateway refused.
type LibraryError struct {
	Error string `json:"error"`
}
