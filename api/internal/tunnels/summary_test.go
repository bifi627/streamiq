package tunnels_test

import (
	"net/http"
	"testing"

	"streamiq/api/internal/apitest"
	"streamiq/api/internal/tunnels"
)

func TestTheSummaryCountsEveryRowOfTheWindowBeyond200PerUser(t *testing.T) {
	s := newServer(t)
	alice, bob := adminAndMember(t, s)
	nas := gateway(t, alice.home, "nas")
	tunnelsAgo(t, alice.home, nas, alice.id, tunnels.Limit+50)
	with := func(user, set string) {
		id := tunnel(t, alice.home, nas, user, "1 hour")
		apitest.Exec(t, `UPDATE tunnels SET `+set+` WHERE id = $1`, id)
	}
	with(bob.id, `use = 'playback', relay = true, bytes_sent = 1000, bytes_received = 24`)
	with(bob.id, `use = 'management', relay = true, bytes_sent = 100`) // hidden, its relay bytes count
	with(bob.id, `use = 'diagnostics'`)                                   // hidden
	with(bob.id, `use = 'management', failure = 'ice failed'`)          // failed: not hidden
	with("", `use = 'browsing'`)                                          // a deleted account
	tunnel(t, alice.home, nas, bob.id, "31 days")

	status, body := s.get(t, alice, alice.home, "/api/tunnels/summary")
	rows := decode[[]tunnels.Summary](t, body)
	if status != http.StatusOK || len(rows) != 3 {
		t.Fatal(status, body)
	}
	want := []tunnels.Summary{ // most tunnels first
		{UserID: &alice.id, Tunnels: tunnels.Limit + 50},
		{UserID: &bob.id, Tunnels: 4, Hidden: 2, Failed: 1, RelayedBytes: 1124},
		{Tunnels: 1},
	}
	for i, w := range want {
		g := rows[i]
		if (g.UserID == nil) != (w.UserID == nil) || g.UserID != nil && *g.UserID != *w.UserID ||
			g.Tunnels != w.Tunnels || g.Hidden != w.Hidden || g.Failed != w.Failed || g.RelayedBytes != w.RelayedBytes {
			t.Errorf("row %d: %s", i, body)
		}
	}
}

// Tenant isolation: Bob's own household counts its one row only, none of the 5 in Alice's.
func TestTheSummaryNeverCountsAnotherHouseholdsRows(t *testing.T) {
	s := newServer(t)
	alice, bob := adminAndMember(t, s)
	tunnelsAgo(t, alice.home, gateway(t, alice.home, "nas"), bob.id, 5)
	tunnel(t, bob.home, gateway(t, bob.home, "other"), bob.id, "1 hour")
	want := `[{"userId":"` + bob.id + `","tunnels":1,"hidden":0,"failed":0,"relayedBytes":0}]`
	if status, body := s.get(t, bob, bob.home, "/api/tunnels/summary"); status != http.StatusOK || body != want {
		t.Fatalf("%d %s\nwant %s", status, body, want)
	}
}
