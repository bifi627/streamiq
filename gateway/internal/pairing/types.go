package pairing

// The bodies of the gateway API endpoints this package serves (api.go), types
// only: scripts/gen-types.sh makes the web app's TypeScript from this file.

import "time"

// The pairing queue's refusals, sent as the auth channel's rejected reason: the web
// app reads both as "busy, try again" (a slot frees up), any other reason as refused.
const (
	RejectedFull        = "too many pending pairing requests"
	RejectedUserPairing = "this user is already pairing a browser"
)

// Client is one item of GET ClientsPath; Self = the calling session's client key.
type Client struct {
	KeyFp   string    `json:"keyFp"`
	Name    string    `json:"name"`
	AddedAt time.Time `json:"addedAt"`
	Self    bool      `json:"self"`
	Profile *Profile  `json:"profile" tstype:"Profile | null,required"`
}

// ClientKey is the body of POST ClientsRemovePath (KeyFp only) and
// ClientsRenamePath.
type ClientKey struct {
	KeyFp string `json:"keyFp"`
	Name  string `json:"name,omitempty"`
}

// ClientName is the reply to POST ClientsRenamePath: the name as stored.
type ClientName struct {
	Name string `json:"name"`
}

// Probe is what a client's browser decodes (the web app's capability probe).
// Hd = at most 1080p: 2160p is not smooth.
type Probe struct {
	H264 *H264 `json:"h264" tstype:"H264 | null,required"`
	// Hevc is HEVC Main.
	Hevc *Hevc `json:"hevc" tstype:"Hevc | null,required"`
	Av1  *Av1  `json:"av1"  tstype:"Av1 | null,required"`
	// Audio holds Jellyfin audio codec names.
	Audio []string `json:"audio"`
	// Surround: 5.1 audio decodes.
	Surround bool `json:"surround"`
}

type H264 struct {
	// Profiles holds Jellyfin names ("high", "constrained baseline").
	Profiles []string `json:"profiles"`
	// Level is the highest, e.g. 51 = 5.1.
	Level int  `json:"level"`
	Hd    bool `json:"hd,omitempty"`
}

type Hevc struct {
	// Level in Jellyfin units: level × 30, e.g. 153 = 5.1.
	Level  int  `json:"level"`
	Main10 bool `json:"main10"`
	Hd     bool `json:"hd,omitempty"`
}

type Av1 struct {
	Main10 bool `json:"main10"`
	Hd     bool `json:"hd,omitempty"`
}

// ProfileIn is the body of POST ClientsProfilePath.
type ProfileIn struct {
	Probe      Probe `json:"probe"`
	Compatible bool  `json:"compatible"`
}

// Profile is a client's last ProfileIn, stamped with the gateway's clock.
type Profile struct {
	Probe      Probe     `json:"probe"`
	Compatible bool      `json:"compatible"`
	ProbedAt   time.Time `json:"probedAt"`
}
