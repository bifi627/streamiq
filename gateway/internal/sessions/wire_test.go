package sessions

import (
	"encoding/json"
	"testing"

	"github.com/pion/webrtc/v4"

	"streamiq/protocol"
)

// The gateway's messages to the broker, byte for byte: the broker reads exactly this.
func TestWire(t *testing.T) {
	var zero uint16
	mid, failure, ms := "0", "ice failed", int64(1500)
	for _, c := range []struct {
		v    any
		want string
	}{
		{
			Msg{Type: "answer", Session: "s1", SDP: &webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: "v=0"}},
			`{"type":"answer","session":"s1","sdp":{"type":"answer","sdp":"v=0"}}`,
		},
		{
			Msg{Type: "ice", Session: "s1", Candidate: &webrtc.ICECandidateInit{
				Candidate: "candidate:1 1 udp 1 10.0.0.1 9 typ host", SDPMid: &mid, SDPMLineIndex: &zero,
			}},
			`{"type":"ice","session":"s1","candidate":{"candidate":"candidate:1 1 udp 1 10.0.0.1 9 typ host","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":null}}`,
		},
		{
			protocol.Report{Type: "tunnel", Session: "s1"},
			`{"type":"tunnel","session":"s1","relay":false,"ipv6":false,"bytesSent":0,"bytesReceived":0,"failure":null}`,
		},
		{
			protocol.Report{
				Type: "tunnel", Session: "s1", Relay: true, Ipv6: true, LocalCandidateType: "relay",
				RemoteCandidateType: "prflx", Protocol: "udp", BytesSent: 10, BytesReceived: 20,
				Failure: &failure, Use: "playback", ActiveMs: &ms,
			},
			`{"type":"tunnel","session":"s1","relay":true,"ipv6":true,"localCandidateType":"relay",` +
				`"remoteCandidateType":"prflx","protocol":"udp","bytesSent":10,"bytesReceived":20,` +
				`"failure":"ice failed","use":"playback","activeMs":1500}`,
		},
	} {
		if b, _ := json.Marshal(c.v); string(b) != c.want {
			t.Errorf("got  %s\nwant %s", b, c.want)
		}
	}
}

// The broker's offer, as the broker sends it, reads into Msg.
func TestWireOffer(t *testing.T) {
	var m Msg
	raw := `{"type":"offer","session":"s1","user":"u1","role":"admin","sdp":{"type":"offer","sdp":"v=0"}}`
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	if m.Type != "offer" || m.Session != "s1" || m.User != "u1" || m.Role != "admin" ||
		m.SDP == nil || m.SDP.Type != webrtc.SDPTypeOffer || m.SDP.SDP != "v=0" {
		t.Fatalf("%+v", m)
	}
}
