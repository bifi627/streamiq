package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewer(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"1.10.0", "1.9.3", true},
		{"1.4.0", "1.4.0", false},
		{"1.3.9", "1.4.0", false},
		{"2.0.0", "1.99.99", true},
		{"1.5.0-nightly.3", "1.4.0", true},
		{"1.4.0", "dev", false}, // dev builds never "need" an update
		{"garbage", "1.0.0", false},
	} {
		if got := Newer(c.a, c.b); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestLatest(t *testing.T) {
	tag := "gateway-v1.5.0"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"tag_name":"` + tag + `"}`))
	}))
	defer srv.Close()
	if v, err := Latest(context.Background(), srv.URL); err != nil || v != "1.5.0" {
		t.Fatalf("Latest = %q, %v", v, err)
	}
	tag = "web-v3.0.0" // not a gateway release
	if v, err := Latest(context.Background(), srv.URL); err != nil || v != "" {
		t.Fatalf("Latest(non-gateway) = %q, %v", v, err)
	}
}

func TestDownloadVerifiesChecksum(t *testing.T) {
	bin := []byte("new gateway")
	h := sha256.Sum256(bin)
	sums := hex.EncodeToString(h[:]) + "  streamiq-gateway-windows-amd64.exe\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/SHA256SUMS":
			w.Write([]byte("0000  other\n" + sums))
		case "/streamiq-gateway-windows-amd64.exe":
			w.Write(bin)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	dst := filepath.Join(t.TempDir(), "gateway.exe.new")
	if err := Download(context.Background(), srv.URL, "streamiq-gateway-windows-amd64.exe", dst); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != string(bin) {
		t.Fatalf("downloaded %q", b)
	}

	bin = []byte("tampered")
	if err := Download(context.Background(), srv.URL, "streamiq-gateway-windows-amd64.exe", dst); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("tampered binary: err = %v", err)
	}
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Fatal("refused download left a file behind")
	}
	if err := Download(context.Background(), srv.URL, "streamiq-gateway-linux-arm64", dst); err == nil {
		t.Fatal("asset missing from SHA256SUMS: want error")
	}
}

func TestSwap(t *testing.T) {
	dir := t.TempDir()
	exe, nw := filepath.Join(dir, "gateway.exe"), filepath.Join(dir, "gateway.exe.new")
	os.WriteFile(exe, []byte("v1"), 0o755)
	os.WriteFile(exe+".old", []byte("v0"), 0o755) // left over from the previous update
	os.WriteFile(nw, []byte("v2"), 0o755)
	if err := Swap(exe, nw); err != nil {
		t.Fatal(err)
	}
	for p, want := range map[string]string{exe: "v2", exe + ".old": "v1"} {
		if b, _ := os.ReadFile(p); string(b) != want {
			t.Errorf("%s = %q, want %q", filepath.Base(p), b, want)
		}
	}
	// Move-in fails (no new file): the old exe stays in place.
	if err := Swap(exe, filepath.Join(dir, "missing")); err == nil {
		t.Fatal("want error")
	}
	if b, _ := os.ReadFile(exe); string(b) != "v2" {
		t.Fatalf("exe after failed swap = %q, want v2 restored", b)
	}
}
