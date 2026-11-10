package jellyfin

import (
	"context"
	"strings"
	"testing"
)

// Only the image tag changes: comments, binds, CRLF and other services stay the user's.
func TestPinRewritesOnlyTheJellyfinImage(t *testing.T) {
	in := "services:\r\n  jellyfin:\r\n    # mine\r\n    image: jellyfin/jellyfin:10.9.1 \r\n    volumes:\r\n      - 'D:\\Movies:/media'\r\n  other:\r\n    image: nginx:1\r\n"
	out, changed, err := Pin([]byte(in))
	want := strings.Replace(in, "jellyfin/jellyfin:10.9.1", Image, 1)
	if err != nil || !changed || string(out) != want {
		t.Fatalf("Pin = %q, %v, %v; want %q", out, changed, err, want)
	}
	if _, changed, err = Pin(out); changed || err != nil {
		t.Fatalf("second Pin: changed %v, err %v", changed, err)
	}
	if _, _, err = Pin([]byte("services:\n  jellyfin:\n    image: linuxserver/jellyfin:10\n")); err == nil {
		t.Fatal("another image: want an error, not a silent no-op")
	}
}

func TestComposeWithoutDocker(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	err := Compose(context.Background(), ComposeFile, "up", "-d")
	if err == nil || !strings.Contains(err.Error(), "Docker not found") {
		t.Fatalf("err = %v", err)
	}
}

func TestUpgradeWithoutFile(t *testing.T) {
	_, err := Upgrade(context.Background(), t.TempDir()+"/"+ComposeFile)
	if err == nil || !strings.Contains(err.Error(), "gateway jellyfin up") {
		t.Fatalf("err = %v", err)
	}
}
