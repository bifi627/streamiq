package sessions

// The `auth` data channel's messages (docs/protocol.md, "Pairing"), types only:
// scripts/gen-types.sh makes the web app's TypeScript from this file.

// Gateway → client.

// Challenge opens the channel: N is the nonce the client signs; Spki is the
// gateway's identity key (the pin) and Sig its proof over this tunnel
// (pairing.GatewayMessage), checked by the client before it sends anything.
type Challenge struct {
	Type string `json:"type" tstype:"'challenge'"`
	N    string `json:"n"`
	Spki []byte `json:"spki" tstype:"string"` // base64
	Sig  []byte `json:"sig"  tstype:"string"` // base64
}

// OK: the client key is paired, the tunnel is up.
type OK struct {
	Type string `json:"type" tstype:"'ok'"`
}

// Unpaired: the client key isn't paired (or the client asked to pair): pairing may follow.
type Unpaired struct {
	Type string `json:"type" tstype:"'unpaired'"`
}

// Nonce is the gateway's pairing nonce, sent after an accepted commit.
type Nonce struct {
	Type string `json:"type" tstype:"'nonce'"`
	N    string `json:"n"`
}

// Approved: the pairing was approved on the local gateway page.
type Approved struct {
	Type string `json:"type" tstype:"'approved'"`
}

// Rejected ends the handshake; the gateway closes the channel after it.
type Rejected struct {
	Type   string `json:"type"   tstype:"'rejected'"`
	Reason string `json:"reason"`
}

// Client → gateway.

// Auth proves the client key: Sig over the challenge and both DTLS fingerprints.
type Auth struct {
	Type string `json:"type"           tstype:"'auth'"`
	Spki []byte `json:"spki"           tstype:"string"` // base64
	Sig  []byte `json:"sig"            tstype:"string"` // base64
	Pair bool   `json:"pair,omitempty"`                 // no matching pin: force the code comparison
}

// Commit is sha256(hex) of the client's pairing nonce, before it sees the gateway's.
type Commit struct {
	Type string `json:"type"           tstype:"'commit'"`
	H    string `json:"h"`
	Name string `json:"name,omitempty"`
}

// Reveal is the committed nonce.
type Reveal struct {
	Type string `json:"type" tstype:"'reveal'"`
	N    string `json:"n"`
}
