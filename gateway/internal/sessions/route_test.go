package sessions

import (
	"net"
	"testing"
)

func TestOnLink(t *testing.T) {
	var nets []*net.IPNet
	for _, c := range []string{"192.168.0.106/24", "2a02:8070:998a:2a40::5/64"} {
		_, n, _ := net.ParseCIDR(c)
		nets = append(nets, n)
	}
	for ip, want := range map[string]bool{
		"192.168.0.42":                      true,  // same Wi-Fi
		"2a02:8070:998a:2a40:1111:2222:3:4": true,  // same IPv6 /64
		"192.168.1.42":                      false, // another subnet (a VPN into a routed LAN)
		"2a02:8070:998a:2a41::1":            false, // another /64
		"203.0.113.7":                       false, // public (cellular, hairpin through the router)
		"2a01:598::1":                       false, // cellular IPv6
		"a1b2-mdns.local":                   false, // unresolved mDNS name
	} {
		if got := onLink(net.ParseIP(ip), nets); got != want {
			t.Errorf("onLink(%s) = %v, want %v", ip, got, want)
		}
	}
}
