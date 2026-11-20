package jellyfin

import (
	"context"
	"testing"
)

// Transcodes counts sessions with TranscodingInfo as the gateway's admin. It
// keeps that token between calls (the gateway's other admin sign-ins don't
// replace it) and signs in again only after a rejection; no admin or a failed
// /Sessions is an error, never a count.
func TestTranscodes(t *testing.T) {
	f, srv := newFake(t, false)
	var got [2]string
	s := newSetup(t, srv.URL, &got)
	ctx := context.Background()
	if _, err := s.Transcodes(ctx); err == nil {
		t.Fatal("no admin yet: want an error")
	}
	s.poll(ctx)
	if n, err := s.Transcodes(ctx); err == nil {
		t.Fatalf("/Sessions fails: want an error, got %d", n)
	}
	f.mu.Lock()
	f.sessions = []map[string]any{{"TranscodingInfo": map[string]any{"Bitrate": 1}}, {"TranscodingInfo": nil}, {}}
	signIns := f.signIns
	f.mu.Unlock()
	count := func() {
		t.Helper()
		if n, err := s.Transcodes(ctx); err != nil || n != 1 {
			t.Fatalf("Transcodes = %d, %v; want 1", n, err)
		}
	}
	count()                                                     // the token from the failed call above
	s.EnsureViewer(ctx, "11111111-1111-1111-1111-111111111111") // the gateway's admin signs in (and out) too
	f.mu.Lock()
	viewer := f.signIns - signIns
	f.mu.Unlock()
	if viewer == 0 {
		t.Fatal("the viewer setup signed nobody in: the check below proves nothing")
	}
	count()
	if f.signIns != signIns+viewer { // the kept token survived the viewer setup's sign-ins
		t.Fatalf("%d sign-ins by Transcodes, want 0", f.signIns-signIns-viewer)
	}

	f.mu.Lock()
	f.revoke("streamiq") // e.g. the password changed in Jellyfin's Dashboard: sign in again, once
	signIns = f.signIns
	f.mu.Unlock()
	count()
	if f.signIns != signIns+1 {
		t.Fatalf("%d sign-ins after a revoked token, want 1", f.signIns-signIns)
	}

	f.mu.Lock()
	f.revoke("streamiq")
	f.users["streamiq"].pw = "changed in Jellyfin"
	signIns = f.signIns
	f.mu.Unlock()
	for range 2 {
		if _, err := s.Transcodes(ctx); err == nil {
			t.Fatal("refused admin: want an error")
		}
	}
	if f.signIns != signIns+1 { // Jellyfin locks a user out after failed sign-ins
		t.Fatalf("%d sign-ins after a refusal, want 1", f.signIns-signIns)
	}
}
