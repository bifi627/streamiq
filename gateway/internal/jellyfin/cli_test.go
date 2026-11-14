package jellyfin

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// `gateway jellyfin login` (#241) restores member viewers on a running gateway
// (another Setup on the same state dir) without a restart, managed and BYO,
// and never prints the password.
func TestLoginCLI(t *testing.T) {
	for _, tc := range []struct {
		name, user, pw, admin string
		wizardDone            bool
	}{
		{"managed", "streamiq", "new-secret", adminName, false},
		{"byo", "me", "pw", byoAdmin, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, srv := newFake(t, tc.wizardDone)
			var got [2]string
			gw := newSetup(t, srv.URL, &got)
			ctx := context.Background()
			gw.poll(ctx)
			if tc.wizardDone {
				if err := gw.Login(ctx, "me", "pw"); err != nil {
					t.Fatal(err)
				}
			} else {
				gw.poll(ctx) // sees the wizard done
			}
			f.mu.Lock()
			f.users[tc.admin].pw = "changed-by-a-human"
			if tc.admin == adminName { // managed: the human types the new one
				f.users[adminName].pw = tc.pw
			}
			f.mu.Unlock()
			gw.EnsureViewer(ctx, alice)
			if !gw.View().NeedsLogin {
				t.Fatalf("not refused: %+v", gw.View())
			}

			cli := &Setup{Client: srv.Client(), URL: srv.URL, StateDir: gw.StateDir, OnKey: func(string, string) {}}
			var out strings.Builder
			err := LoginCLI(ctx, cli, strings.NewReader(tc.user+"\n"), &out, func() (string, error) { return tc.pw, nil })
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(out.String(), tc.pw) || !strings.Contains(out.String(), "gateway status") {
				t.Fatalf("output: %q", out.String())
			}
			later := time.Now().Add(time.Second) // a coarse mtime still moves
			os.Chtimes(gw.path(), later, later)

			gw.poll(ctx)
			if v := gw.View(); v.NeedsLogin {
				t.Fatalf("still needs a login: %+v", v)
			}
			gw.EnsureViewer(ctx, alice)
			mine(t, f, gw, alice)
		})
	}
}
