package sessions

import (
	"net"
	"testing"
)

func TestDecide(t *testing.T) {
	var nets []*net.IPNet
	for _, c := range []string{"192.168.0.106/24", "2a02:8070:998a:2a40::5/64"} {
		_, n, _ := net.ParseCIDR(c)
		nets = append(nets, n)
	}
	for _, c := range []struct {
		relay  bool
		remote string
		want   string
	}{
		{false, "192.168.0.42", "lan"},                      // same Wi-Fi
		{false, "2a02:8070:998a:2a40:1111:2222:3:4", "lan"}, // same IPv6 /64
		{false, "a1b2c3d4-mdns.local", "lan"},               // Chrome's mDNS name, resolved on this link
		{false, "192.168.1.42", "direct"},                   // another subnet (a VPN into a routed LAN)
		{false, "2a02:8070:998a:2a41::1", "direct"},         // another /64
		{false, "203.0.113.7", "direct"},                    // public: cellular, or a hairpin through the router
		{false, "2a01:598::1", "direct"},                    // cellular IPv6
		{false, "", "direct"},                               // no selected pair
		{true, "192.168.0.42", "relay"},                     // relay wins over the subnet
		{true, "203.0.113.7", "relay"},
	} {
		if got := decide(c.relay, c.remote, nets); got != c.want {
			t.Errorf("decide(%v, %q) = %s, want %s", c.relay, c.remote, got, c.want)
		}
	}
}
