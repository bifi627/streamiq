// Package proto holds the broker's wire messages (docs/protocol.md, "Broker"), shared by
// the gateway and the Go API, and the source of the web app's generated TypeScript (tygo).
// Types only: no pion, no database, so both binaries and the generator can import it.
package proto

// Msg is the envelope between broker and gateway on the control socket. The gateway
// reads SDP and candidate as pion types; the broker relays them as sent (json.RawMessage).
type Msg[S, C any] struct {
	Type      string `json:"type" tstype:"'offer' | 'answer' | 'ice' | 'bye'"`
	Session   string `json:"session"`
	User      string `json:"user,omitempty"` // offer only: the signed-in user's users.id, stamped by the broker
	Role      string `json:"role,omitempty" tstype:"Role"`
	SDP       *S     `json:"sdp,omitempty"`
	Candidate *C     `json:"candidate,omitempty"`
}

// Roles of a membership, as the broker stamps them on an offer.
const (
	Admin  = "admin"
	Member = "member"
)

// Report is the gateway's account of a tunnel, sent once when its PeerConnection ends:
// the broker fills that tunnel's row with it. local = the gateway's side of the selected
// pair, remote = the browser's; bytes as the gateway counted them (sent = gateway → client).
type Report struct {
	Type                string  `json:"type" tstype:"'tunnel'"`
	Session             string  `json:"session"`
	Relay               bool    `json:"relay"`
	Ipv6                bool    `json:"ipv6"`
	LocalCandidateType  string  `json:"localCandidateType,omitempty"`
	RemoteCandidateType string  `json:"remoteCandidateType,omitempty"`
	Protocol            string  `json:"protocol,omitempty"`
	BytesSent           uint64  `json:"bytesSent"`
	BytesReceived       uint64  `json:"bytesReceived"`
	Failure             *string `json:"failure"`            // nil = the tunnel came up and passed auth
	Use                 string  `json:"use,omitempty"`      // what it was for; "" = no request served
	ActiveMs            *int64  `json:"activeMs,omitempty"` // from the offer to its last request's end; nil = none served
}

// Heartbeat is the gateway's liveness message, every 30 s.
type Heartbeat struct {
	Type     string `json:"type" tstype:"'heartbeat'"`
	LanURL   string `json:"lanUrl"`
	Version  string `json:"version"`
	Update   string `json:"update,omitempty"` // newer release version, "" = up to date
	Protocol int    `json:"protocol"`
	Name     string `json:"name"` // the API mirrors it
	// Telemetry is the level; Health what it allows (none at off). Older APIs ignore both.
	Telemetry string  `json:"telemetry" tstype:"'off' | 'full'"`
	Health    *Health `json:"health,omitempty"`
}

// Telemetry levels.
const (
	Off  = "off"
	Full = "full"
)

// Health is the heartbeat's `health` at Full. Counts and versions only: never
// names, users, client keys, media titles, file names or paths.
type Health struct {
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

// Jellyfin is Health's Jellyfin part.
type Jellyfin struct {
	Reachable bool   `json:"reachable"`
	Version   string `json:"version"`
}

// Auth is the browser's first message on /api/broker/ws.
type Auth struct {
	Type  string `json:"type" tstype:"'auth'"`
	Token string `json:"token"` // Firebase ID token
}

// ICEServer is one entry of Ready's list (RTCIceServer).
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// Ready answers a good Auth: this session's ICE servers.
type Ready struct {
	Type       string      `json:"type" tstype:"'ready'"`
	ICEServers []ICEServer `json:"iceServers"`
}

// Offer is the browser's offer to one gateway.
type Offer[S any] struct {
	Type      string `json:"type" tstype:"'offer'"`
	GatewayID string `json:"gatewayId"`
	SDP       *S     `json:"sdp"`
}

// Answer is the gateway's answer as the browser gets it. Tunnel is the tunnel's id
// (the broker session), for the browser's throughput PATCH.
type Answer[S any] struct {
	Type   string `json:"type" tstype:"'answer'"`
	SDP    *S     `json:"sdp"`
	Tunnel string `json:"tunnel"`
}

// Ice is one trickled candidate between browser and broker, either way.
type Ice[C any] struct {
	Type      string `json:"type" tstype:"'ice'"`
	Candidate *C     `json:"candidate"`
}

// Error tells the browser why its offer went nowhere.
type Error struct {
	Type  string `json:"type" tstype:"'error'"`
	Error string `json:"error"`
}
