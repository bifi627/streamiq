package broker_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	"streamiq/api/internal/apitest"
)

// A TURN credential is minted only for the gateway the auth names, when the user's offer
// could reach it now, tagged as that gateway's: Cloudflare's usage analytics count each
// gateway's relayed bytes by that tag. Anything else gets STUN only, all alike.
func TestTURNIsMintedOnlyForAReachableGatewayTaggedAsIts(t *testing.T) {
	f := &fakeCloudflare{}
	s := newStack(t, cloudflare(t, f, 5*time.Second), 1000)
	nas := s.online("alice@home.test", "nas")
	offline := s.enrolled("alice@home.test", "offline")
	revoked := s.online("alice@home.test", "revoked")
	apitest.Exec(t, `UPDATE gateways SET credential_hash = NULL WHERE id = $1`, revoked.id)

	if _, servers := ready(t, s, "alice@home.test", nas.id); len(servers) != 2 {
		t.Fatal(servers)
	}
	tag := apitest.Scalar[string](t, `SELECT relay_tag FROM gateways WHERE id = $1`, nas.id)
	var body struct {
		TTL              int
		CustomIdentifier string
	}
	if b := f.minted(); len(b) != 1 || json.Unmarshal([]byte(b[0]), &body) != nil ||
		body.CustomIdentifier != tag || tag == nas.id || tag == nas.tenant || body.TTL != 4*60*60 {
		t.Fatal(f.minted(), tag)
	}

	for who, named := range map[string]string{
		"bob@home.test":   nas.id,           // another household's
		"alice@home.test": offline.id,       // not online
		"dave@home.test":  uuid.NewString(), // unknown
		"carol@home.test": "",               // none: a web app from before auth.gatewayId
	} {
		if _, servers := ready(t, s, who, named); len(servers) != 1 {
			t.Fatal(who, servers)
		}
	}
	if _, servers := ready(t, s, "alice@home.test", revoked.id); len(servers) != 1 {
		t.Fatal(servers)
	}
	if b := f.minted(); len(b) != 1 {
		t.Fatal("minted for an unreachable gateway:", b)
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
