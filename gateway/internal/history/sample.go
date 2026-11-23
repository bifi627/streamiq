package history

// Sample is the box's health as the gateway records it in its own history. Counts and
// versions only: never names, users, client keys, media titles, file names or paths.
type Sample struct {
	Jellyfin    Jellyfin `json:"jellyfin"`
	OS          string   `json:"os"`
	Arch        string   `json:"arch"`
	Transcoding string   `json:"transcoding"`          // hardware acceleration, as in GET /streamiq/status
	Offline     string   `json:"offline,omitempty"`    // jail state; none without a compose Jellyfin
	Tunnels     int      `json:"tunnels"`              // active tunnels
	Transcodes  *int     `json:"transcodes,omitempty"` // none when Jellyfin's /Sessions couldn't be read
	CPU         *float64 `json:"cpu,omitempty"`        // busy %, 0–100
	Memory      *float64 `json:"memory,omitempty"`     // used %, 0–100
}

// Jellyfin is Sample's Jellyfin part.
type Jellyfin struct {
	Reachable bool   `json:"reachable"`
	Version   string `json:"version"`
}
