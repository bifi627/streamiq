package tunnel

// Report is the gateway's account of a tunnel, made once when its PeerConnection
// ends: history makes its line from it. Bytes as the gateway counted them on the ICE
// transport (sent = gateway → client).
type Report struct {
	Session       string
	Relay         bool
	Ipv6          bool
	BytesSent     uint64
	BytesReceived uint64
	Failure       *string // nil = the tunnel came up and passed auth
	Use           string  // what it was for; "" = no request served
	ActiveMs      *int64  // from the offer to its last request's end; nil = none served
}
