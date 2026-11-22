package jellyfin

import (
	"bytes"
	"context"
	"io"
	"os"
	"strings"
	"testing"
)

// A second gateway's file: its own project and port in both the online and
// the offline (forwarder) port lines; the default gateway's file is unchanged.
func TestInstance(t *testing.T) {
	b, err := os.ReadFile("../../install/" + ComposeFile)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(Instance(b, "streamiq-jellyfin", "8096"), b) {
		t.Error("the default instance changed the file")
	}
	got := string(Instance(b, "streamiq-jellyfin-kids", "8098"))
	if !strings.Contains(got, "\nname: streamiq-jellyfin-kids\n") || strings.Contains(got, "8096:") ||
		strings.Count(got, `"8098:8096"`) != 2 {
		t.Errorf("Instance:\n%s", got)
	}
}

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
	err := Upgrade(context.Background(), t.TempDir()+"/"+ComposeFile, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "gateway jellyfin up") {
		t.Fatalf("err = %v", err)
	}
}
