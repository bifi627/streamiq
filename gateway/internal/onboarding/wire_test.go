package onboarding

import (
	"encoding/json"
	"testing"

	"streamiq/protocol"
)

// The heartbeat at telemetry full, byte for byte: the .NET broker reads exactly this.
func TestWireHeartbeat(t *testing.T) {
	n, cpu, mem := 0, 12.5, 47.3
	hb := protocol.Heartbeat{
		Type: "heartbeat", LanURL: "http://192.168.1.20:8097", Version: "1.4.0", Update: "1.5.0",
		Protocol: 2, Name: "nas", Telemetry: "full",
		Health: &protocol.Health{
			Jellyfin: protocol.Jellyfin{Reachable: true, Version: "10.11.2"}, OS: "windows", Arch: "amd64",
			Transcoding: "nvenc", Offline: "enforced", Tunnels: 1, Transcodes: &n, CPU: &cpu, Memory: &mem,
		},
	}
	want := `{"type":"heartbeat","lanUrl":"http://192.168.1.20:8097","version":"1.4.0","update":"1.5.0",` +
		`"protocol":2,"name":"nas","telemetry":"full","health":{"jellyfin":{"reachable":true,"version":"10.11.2"},` +
		`"os":"windows","arch":"amd64","transcoding":"nvenc","offline":"enforced","tunnels":1,"transcodes":0,` +
		`"cpu":12.5,"memory":47.3}}`
	if b, _ := json.Marshal(hb); string(b) != want {
		t.Errorf("got  %s\nwant %s", b, want)
	}
}
