package pairing

// The bodies of the gateway API endpoints this package serves (api.go), types
// only: scripts/gen-types.sh makes the web app's TypeScript from this file.

import "time"

// Client is one item of GET ClientsPath; Self = the calling session's client key.
type Client struct {
	KeyFp   string    `json:"keyFp"`
	Name    string    `json:"name"`
	AddedAt time.Time `json:"addedAt"`
	Self    bool      `json:"self"`
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
