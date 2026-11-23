package broker_test

import (
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"

	"streamiq/api/internal/apitest"
)

// A TURN credential is minted only for the gateway the auth names, when it is one of the
// user's households' and not revoked, online or not (one that comes online right after
// `ready` still gets a relay), tagged as that gateway's: Cloudflare's usage analytics
// count each gateway's relayed bytes by that tag. Anything else gets STUN only, all alike.
func TestTURNIsMintedOnlyForAGatewayOfTheUsersHouseholdsTaggedAsIts(t *testing.T) {
	f := &fakeCloudflare{}
	s := newStack(t, cloudflare(t, f, 5*time.Second), 1000)
	nas := s.online("alice@home.test", "nas")
	offline := s.enrolled("alice@home.test", "offline")
	revoked := s.online("alice@home.test", "revoked")
	apitest.Exec(t, `UPDATE gateways SET credential_hash = NULL WHERE id = $1`, revoked.id)
	_, bob := s.user("bob@home.test")
	s.household("bob@home.test")
	apitest.Join(t, bob, s.household("alice@home.test"), "member") // alice's is bob's second household
	tag := func(g *gw) string {
		return apitest.Scalar[string](t, `SELECT relay_tag FROM gateways WHERE id = $1`, g.id)
	}

	for _, c := range []struct {
		who string
		gw  *gw
	}{{"alice@home.test", nas}, {"alice@home.test", offline}, {"bob@home.test", nas}} {
		if _, servers := ready(t, s, c.who, c.gw.id); len(servers) != 2 {
			t.Fatal(c.who, c.gw.id, servers)
		}
	}
	var tags []string
	for _, b := range f.minted() {
		var body struct {
			TTL              int
			CustomIdentifier string
		}
		if json.Unmarshal([]byte(b), &body) != nil || body.TTL != 4*60*60 {
			t.Fatal(b)
		}
		tags = append(tags, body.CustomIdentifier)
	}
	if want := []string{tag(nas), tag(offline), tag(nas)}; !slices.Equal(tags, want) ||
		tag(nas) == nas.id || tag(nas) == nas.tenant {
		t.Fatal(tags, want)
	}

	for who, named := range map[string]string{
		"carol@home.test": nas.id,           // another household's
		"alice@home.test": revoked.id,       // removed
		"dave@home.test":  uuid.NewString(), // unknown
		"erin@home.test":  "",               // none: a web app from before auth.gatewayId
	} {
		if _, servers := ready(t, s, who, named); len(servers) != 1 {
			t.Fatal(who, servers)
		}
	}
	if b := f.minted(); len(b) != 3 {
		t.Fatal("minted for a gateway out of reach:", b)
	}
}

func TestAnOfferForAnotherGatewayThanTheNamedOneIsRefused(t *testing.T) {
	s := newBroker(t)
	nas := s.online("alice@home.test", "nas")
	other := s.online("alice@home.test", "other")
	c := s.browserIn("alice@home.test", nas.id, nil)
	offerTo(t, c, other)
	refused(t, c)
	nothing(t, other.conn)
	offerTo(t, c, nas) // the named one still goes through
	session(t, nas)
}

// A gateway with its relay off (its heartbeat says so) gets no TURN credential for its
// tunnels: STUN only, and `ready` says why. Its relay back on, the next one gets one.
func TestAGatewayWithItsRelayOffGetsNoTURNCredential(t *testing.T) {
	f := &fakeCloudflare{}
	s := newStack(t, cloudflare(t, f, 5*time.Second), 1000)
	direct := s.online("alice@home.test", "direct")
	other := s.online("alice@home.test", "other")
	s.heartbeat(direct, map[string]any{"relayOff": true})

	if _, m := readyMsg(
		t,
		s,
		"alice@home.test",
		direct.id,
	); len(m["iceServers"].([]any)) != 1 ||
		m["relayOff"] != true {
		t.Fatal(m)
	}
	if _, m := readyMsg(t, s, "alice@home.test", other.id); len(m["iceServers"].([]any)) != 2 || m["relayOff"] != nil {
		t.Fatal(m)
	}
	if b := f.minted(); len(b) != 1 {
		t.Fatal("minted for a gateway with its relay off:", b)
	}

	s.heartbeat(direct, map[string]any{})
	if _, servers := ready(t, s, "alice@home.test", direct.id); len(servers) != 2 {
		t.Fatal(servers)
	}
}
