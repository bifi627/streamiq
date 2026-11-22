package screen

// The bodies of the screen endpoints (docs/protocol.md, "Screens"), types only:
// scripts/gen-types.sh makes the web app's TypeScript from this file.

// ScreenState is the TV's playback state (POST ScreenPath/state; GET ScreensPath
// item). Ticks are integers. Audio / Subtitle are Jellyfin stream indexes; null =
// none chosen, subtitle -1 = off.
type ScreenState struct {
	ItemID        string `json:"itemId"` // "" while nothing plays
	PositionTicks int64  `json:"positionTicks"`
	DurationTicks int64  `json:"durationTicks"`
	Paused        bool   `json:"paused"`
	Audio         *int   `json:"audio"         tstype:"number | null,required"`
	Subtitle      *int   `json:"subtitle"      tstype:"number | null,required"`
}

// Screen is one item of GET ScreensPath.
type Screen struct {
	ID    string       `json:"id"`
	Name  string       `json:"name"`
	State *ScreenState `json:"state" tstype:"ScreenState | null,required"`
}

// The screen commands: POST ScreensPath/{id} body, and each NDJSON line of GET
// ScreenPath (in arrival order; the TV closing it ends the screen).

type PlayCommand struct {
	Type       string `json:"type"                 tstype:"'play'"`
	ItemID     string `json:"itemId"`
	StartTicks *int64 `json:"startTicks,omitempty"`
}

type PauseCommand struct {
	Type string `json:"type" tstype:"'pause'"`
}

type ResumeCommand struct {
	Type string `json:"type" tstype:"'resume'"`
}

type StopCommand struct {
	Type string `json:"type" tstype:"'stop'"`
}

type SeekCommand struct {
	Type  string `json:"type"  tstype:"'seek'"`
	Ticks int64  `json:"ticks"`
}

// TracksCommand sets at least one of them; subtitle -1 = off.
type TracksCommand struct {
	Type     string `json:"type"               tstype:"'tracks'"`
	Audio    *int   `json:"audio,omitempty"`
	Subtitle *int   `json:"subtitle,omitempty"`
}
