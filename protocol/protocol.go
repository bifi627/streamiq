// Package protocol holds the broker's messages on both of its sockets (docs/protocol.md,
// "Gateway onboarding" + "Broker"): the gateway's on /api/gateways/ws, the browser's on
// /api/broker/ws. The gateway and the Go API use them; scripts/gen-types.sh makes the
// web app's TypeScript from them. Types only: no pion, no database, nothing from gateway/
// or api/, so every side can import it.
package protocol

import "encoding/json"

// Msg is the envelope between broker and gateway on /api/gateways/ws. S and C are the
// SDP and the ICE candidate: the gateway reads them as pion's types, the broker relays
// them as sent (json.RawMessage).
type Msg[S, C any] struct {
	Type      string `json:"type"                tstype:"'offer' | 'answer' | 'ice' | 'bye'"`
	Session   string `json:"session"`
	User      string `json:"user,omitempty"`                    // offer only: the signed-in user's users.id, stamped by the broker
	Role      string `json:"role,omitempty"      tstype:"Role"` // offer only: that user's role in this gateway's household
	SDP       *S     `json:"sdp,omitempty"`                     // offer, answer
	Candidate *C     `json:"candidate,omitempty"`               // ice
}

// GatewayBusy is the one GatewayError the broker relays: the gateway holds as many
// unauthenticated connections as it takes; a retry may get through.
const GatewayBusy = "gateway busy"

// GatewayError is the gateway's refusal of a session's offer (on /api/gateways/ws); the
// broker relays it to that session's browser as an ErrorMsg, only with GatewayBusy.
type GatewayError struct {
	Type    string `json:"type"    tstype:"'error'"`
	Session string `json:"session"`
	Error   string `json:"error"`
}

// Report is the gateway's account of a tunnel, made once when its PeerConnection
// ends: its line in the gateway's tunnel history. Never sent to the API (older
// gateways sent it as `tunnel`; the broker ignores it).
// local = the gateway's side of the selected pair, remote = the browser's; bytes as
// the gateway counted them on the ICE transport (sent = gateway → client).
type Report struct {
	Session             string  `json:"session"`
	Relay               bool    `json:"relay"`
	Ipv6                bool    `json:"ipv6"`
	LocalCandidateType  string  `json:"localCandidateType,omitempty"`
	RemoteCandidateType string  `json:"remoteCandidateType,omitempty"`
	Protocol            string  `json:"protocol,omitempty"`
	BytesSent           uint64  `json:"bytesSent"`
	BytesReceived       uint64  `json:"bytesReceived"`
	Failure             *string `json:"failure"                       tstype:"string | null,required"` // nil = the tunnel came up and passed auth
	Use                 string  `json:"use,omitempty"`                                                 // what it was for; "" = no request served
	ActiveMs            *int64  `json:"activeMs,omitempty"`                                            // from the offer to its last request's end; nil = none served
}

// Heartbeat is the gateway's liveness message: on connect, every 30 s, and early on a
// change of what the API mirrors (name, relay setting).
type Heartbeat struct {
	Type     string `json:"type"               tstype:"'heartbeat'"`
	LanURL   string `json:"lanUrl"`
	Version  string `json:"version"`
	Update   string `json:"update,omitempty"` // newer release version, "" = up to date
	Protocol int    `json:"protocol"`
	Name     string `json:"name"`
	RelayOff bool   `json:"relayOff,omitempty"` // direct connections only: the broker mints no TURN credential
}

// Health is the box's health as the gateway records it in its own history. Counts and
// versions only: never names, users, client keys, media titles, file names or paths.
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
	Type  string `json:"type"  tstype:"'auth'"`
	Token string `json:"token"` // Firebase ID token
	// GatewayID is the gateway this session's offer goes to: TURN is minted for it only
	// (relay usage), and an offer to another one is refused.
	GatewayID string `json:"gatewayId"`
}

// Ping keeps the browser's socket open through idle proxies; the broker ignores it.
type Ping struct {
	Type string `json:"type" tstype:"'ping'"`
}

// Ready answers a good Auth with this session's ICE servers, passed through as the
// TURN provider made them.
type Ready struct {
	Type       string            `json:"type"       tstype:"'ready'"`
	ICEServers []json.RawMessage `json:"iceServers" tstype:"RTCIceServer[]"`
	// RelayOff: the named gateway allows direct connections only, so iceServers is STUN only.
	RelayOff bool `json:"relayOff,omitempty"`
}

// Offer is the browser's offer to one gateway.
type Offer[S any] struct {
	Type      string `json:"type"      tstype:"'offer'"`
	GatewayID string `json:"gatewayId"`
	SDP       *S     `json:"sdp"       tstype:",required"`
}

// Answer is the gateway's answer as the browser gets it.
type Answer[S any] struct {
	Type string `json:"type" tstype:"'answer'"`
	SDP  *S     `json:"sdp"  tstype:",required"`
}

// Ice is one trickled candidate between browser and broker, either way.
type Ice[C any] struct {
	Type      string `json:"type"      tstype:"'ice'"`
	Candidate *C     `json:"candidate" tstype:",required"`
}

// ErrorMsg tells the browser why its offer went nowhere.
type ErrorMsg struct {
	Type  string `json:"type"  tstype:"'error'"`
	Error string `json:"error"`
}
