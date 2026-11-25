package onboarding

import (
	"encoding/json"
	"testing"

	"streamiq/protocol"
)

// The heartbeat, byte for byte: the broker reads exactly this.
func TestWireHeartbeat(t *testing.T) {
	hb := protocol.Heartbeat{
		Type: "heartbeat", LanURL: "http://192.168.1.20:8097", Version: "1.4.0", Update: "1.5.0",
		Protocol: 3, Name: "nas", RelayOff: true,
	}
	want := `{"type":"heartbeat","lanUrl":"http://192.168.1.20:8097","version":"1.4.0","update":"1.5.0",` +
		`"protocol":3,"name":"nas","relayOff":true}`
	if b, _ := json.Marshal(hb); string(b) != want {
		t.Errorf("got  %s\nwant %s", b, want)
	}
}
