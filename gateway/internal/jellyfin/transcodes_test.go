package jellyfin

import (
	"context"
	"testing"
)

// Transcodes counts sessions with TranscodingInfo, as the gateway's admin
// (signed out after); no admin or a failed /Sessions is an error, never a count.
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
	f.mu.Unlock()
	if n, err := s.Transcodes(ctx); err != nil || n != 1 {
		t.Fatalf("Transcodes = %d, %v; want 1", n, err)
	}
	connected(t, f, s, got) // the admin's session was logged out

	f.mu.Lock()
	f.users["streamiq"].pw = "changed in Jellyfin"
	f.mu.Unlock()
	signIns := f.signIns
	for range 2 {
		if _, err := s.Transcodes(ctx); err == nil {
			t.Fatal("refused admin: want an error")
		}
	}
	if f.signIns != signIns+1 { // Jellyfin locks a user out after failed sign-ins
		t.Fatalf("%d sign-ins after a refusal, want 1", f.signIns-signIns)
	}
}
