package jellyfin

// The gateway API's library bodies (docs/protocol.md), types only:
// scripts/gen-types.sh makes the web app's TypeScript from this file.

// Library is one library of GET /streamiq/libraries.
type Library struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"` // Jellyfin's collection type: movies, tvshows, … ("" = mixed)
	// folder paths as Jellyfin sees them (/media/<name> for one added here)
	Folders []string `json:"folders"`
	// every type the library can hold has every metadata and image fetcher off
	Offline  bool   `json:"offline"`
	Extras   string `json:"extras"` // on | off | custom
	Scanning bool   `json:"scanning"`
	Progress int    `json:"progress"` // 0–100 while scanning
}

// MediaFolder is one folder of GET /streamiq/libraries/folders.
type MediaFolder struct {
	Path string `json:"path"` // /media/<name>
	// libraries holding it or a folder above it: in use, not offered again
	Libraries []string `json:"libraries"`
}

// NewLibrary is the body of POST /streamiq/libraries/create.
type NewLibrary struct {
	Name    string   `json:"name"`
	Type    string   `json:"type"`    // movies | tvshows
	Folders []string `json:"folders"` // paths from the folder list, one or more
}

// LibraryFolder is the body of POST /streamiq/libraries/folders/add and /remove.
type LibraryFolder struct {
	ID     string `json:"id"`
	Folder string `json:"folder"`
}

// LibraryID is the body of POST /streamiq/libraries/rescan and /remove.
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
