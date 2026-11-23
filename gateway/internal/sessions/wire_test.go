package sessions

import (
	"encoding/json"
	"testing"

	"github.com/pion/webrtc/v4"
)

// The gateway's messages to the broker, byte for byte: the broker reads exactly this.
func TestWire(t *testing.T) {
	var zero uint16
	mid := "0"
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
