package tunnel

// Report is the gateway's account of a tunnel, made once when its PeerConnection
// ends: what history records as its line.
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
	Failure             *string `json:"failure"`            // nil = the tunnel came up and passed auth
	Use                 string  `json:"use,omitempty"`      // what it was for; "" = no request served
	ActiveMs            *int64  `json:"activeMs,omitempty"` // from the offer to its last request's end; nil = none served
}
