package tunnel

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const (
	key = "0000aaaa1111bbbb2222cccc3333dddd"
	uid = "0123456789abcdef0123456789abcdef"
	vid = "aad7cecccec3a4dc85db63021e5bfd99"
)

// fakeJellyfin serves a range-able /Videos file,
// a playlist that echoes the token (like Jellyfin's subtitle URIs), and
// records the last request so tests can see what the gateway forwarded.
func fakeJellyfin(t *testing.T) (*Jellyfin, *http.Request) {
	t.Helper()
	payload := bytes.Repeat([]byte("data-"), 400) // 2000 bytes
	last := &http.Request{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != `MediaBrowser Token="`+key+`"` {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		*last = *r
		b, _ := io.ReadAll(r.Body)
		last.Header.Set("X-Test-Body", string(b))
		switch {
		case strings.HasSuffix(r.URL.Path, ".m3u8"):
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			pl := []byte("#EXTM3U\nstream.vtt?ApiKey=" + key + "\n")
			if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") { // like Jellyfin's response compression
				w.Header().Set("Content-Encoding", "gzip")
				z := gzip.NewWriter(w)
				z.Write(pl)
				z.Close()
				return
			}
			w.Write(pl)
		default:
			http.ServeContent(w, r, "x.ts", time.Time{}, bytes.NewReader(payload))
		}
	}))
	t.Cleanup(srv.Close)
	j := &Jellyfin{Client: http.DefaultClient, URL: srv.URL}
	j.SetKey(key, uid)
	return j, last
}

// Seek survives the tunnel: a Range request comes back 206 with the right bytes.
func TestProxyRangePassthrough(t *testing.T) {
	j, _ := fakeJellyfin(t)
	status, hdr, body := do(t, j, tunnelReq{Method: "GET", URL: "/Videos/" + vid + "/hls1/main/0.ts"})
	if status != 200 || len(body) != 2000 || hdr["Content-Length"] != "2000" {
		t.Fatalf("full GET = %d, %d bytes, Content-Length %q", status, len(body), hdr["Content-Length"])
	}
	status, hdr, part := do(t, j, tunnelReq{
		Method: "GET", URL: "/Videos/" + vid + "/hls1/main/0.ts",
		Headers: map[string]string{"Range": "bytes=0-99"},
	})
	if status != 206 || len(part) != 100 || hdr["Content-Range"] == "" {
		t.Fatalf("ranged GET = %d, %d bytes, Content-Range %q", status, len(part), hdr["Content-Range"])
	}
}

// Only consumption endpoints pass (defense in depth: the token is a viewer).
func TestAllowlist(t *testing.T) {
	for _, c := range []struct {
		method, url string
		ok          bool
	}{
		{"GET", "/UserViews", true},
		{"GET", "/Items?parentId=" + vid + "&recursive=true", true},
		{"GET", "/Items/" + vid, true},
		{"GET", "/UserItems/Resume", true},
		{"GET", "/Shows/" + vid + "/Episodes?seasonId=" + vid, true},
		{"GET", "/Items/" + vid + "/Images/Primary?maxWidth=300", true},
		{"POST", "/Items/" + vid + "/PlaybackInfo", true},
		{"POST", "/UserItems/" + vid + "/UserData", true},
		{"GET", "/Videos/" + vid + "/master.m3u8?mediaSourceId=" + vid, true},
		{"GET", "/Videos/" + vid + "/" + vid + "/Subtitles/0/0/stream.vtt", true},
		{"GET", "/videos/7a3ef65e-2921-cba5-c000-93ee87cf13e1/master.m3u8?MediaSourceId=" + vid, true}, // TranscodingUrl
		{"GET", "/videos/" + vid + "/../../Auth/Keys", false},
		{"GET", "/System/Info/Public", true},

		{"DELETE", "/Items/" + vid, false},
		{"POST", "/Items/" + vid, false}, // metadata edit
		{"DELETE", "/Items?ids=" + vid, false},
		{"GET", "/Users", false},
		{"GET", "/Auth/Keys", false},
		{"POST", "/Library/Refresh", false},
		{"GET", "/System/Configuration", false},
		{"POST", "/Startup/User", false},
		{"GET", "/web/index.html", false},
		{"GET", "/Videos/" + vid + "/../../Auth/Keys", false},
		{"GET", "/Videos/" + vid + "/%2e%2e/%2e%2e/Auth/Keys", false},
		{"GET", "/Videos/" + vid + "//x", false},
		{"GET", "http://evil.example/UserViews", false},
		{"GET", "/Items/not-an-id", false},
	} {
		j, _ := fakeJellyfin(t)
		raw, _ := json.Marshal(tunnelReq{Method: c.method, URL: c.url})
		status, _, body, err := proxy(j, raw)
		if body != nil {
			body.Close()
		}
		if refused := status == http.StatusForbidden && err != nil; refused == c.ok {
			t.Errorf("%s %s: status %d err %v, want allowed=%v", c.method, c.url, status, err, c.ok)
		}
	}
}

// The browser's credentials never reach Jellyfin; the gateway's token does, the
// request is pinned to the token's user, and echoed tokens are redacted.
func TestCredentialsAndUser(t *testing.T) {
	j, last := fakeJellyfin(t)
	status, hdr, body := do(t, j, tunnelReq{
		Method: "GET",
		URL:    "/Videos/" + vid + "/master.m3u8?api_key=stolen&ApiKey=stolen&UserId=someone-else&mediaSourceId=" + vid,
		Headers: map[string]string{
			"Authorization": `MediaBrowser Token="stolen"`, "X-Emby-Token": "stolen", "Cookie": "a=b",
			"Accept-Encoding": "gzip", // must not stop redact from seeing the key
		},
	})
	if status != 200 {
		t.Fatalf("status %d", status)
	}
	q := last.URL.Query()
	if q.Get("userId") != uid || q.Get("api_key") != "" || q.Get("ApiKey") != "" || q.Get("UserId") != "" ||
		q.Get("mediaSourceId") != vid {
		t.Fatalf("forwarded query = %v", q)
	}
	if last.Header.Get("X-Emby-Token") != "" || last.Header.Get("Cookie") != "" {
		t.Fatalf("browser credentials forwarded: %v", last.Header)
	}
	if strings.Contains(string(body), key) || !strings.Contains(string(body), "ApiKey=redacted") {
		t.Fatalf("playlist not redacted: %q", body)
	}
	if hdr["Content-Length"] != fmt.Sprint(len(body)) {
		t.Fatalf("Content-Length after redaction = %q, body is %d", hdr["Content-Length"], len(body))
	}
}

func TestPostBody(t *testing.T) {
	j, last := fakeJellyfin(t)
	do(t, j, tunnelReq{Method: "POST", URL: "/UserItems/" + vid + "/UserData", Body: `{"PlaybackPositionTicks":10}`})
	if last.Header.Get("X-Test-Body") != `{"PlaybackPositionTicks":10}` || last.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("forwarded body %q, type %q", last.Header.Get("X-Test-Body"), last.Header.Get("Content-Type"))
	}
	raw, _ := json.Marshal(tunnelReq{Method: "POST", URL: "/Items/" + vid + "/PlaybackInfo", Body: strings.Repeat("x", MaxBody+1)})
	if status, _, _, err := proxy(j, raw); status != http.StatusRequestEntityTooLarge || err == nil {
		t.Fatalf("oversized body: status %d", status)
	}
}

// No token (or a token without its user) refuses instead of guessing a user.
func TestNoToken(t *testing.T) {
	j, _ := fakeJellyfin(t)
	raw, _ := json.Marshal(tunnelReq{Method: "GET", URL: "/UserViews"})
	for _, c := range []struct{ key, user string }{{"", ""}, {key, ""}, {"", uid}} {
		j.SetKey(c.key, c.user)
		if status, _, _, _ := proxy(j, raw); status != http.StatusServiceUnavailable {
			t.Errorf("SetKey(%q, %q): status %d, want 503", c.key, c.user, status)
		}
	}
}

func do(t *testing.T, j *Jellyfin, rq tunnelReq) (int, map[string]string, []byte) {
	t.Helper()
	raw, _ := json.Marshal(rq)
	status, hdr, body, err := proxy(j, raw)
	if err != nil {
		t.Fatalf("proxy %s %s: %v", rq.Method, rq.URL, err)
	}
	defer body.Close()
	b, _ := io.ReadAll(body)
	return status, hdr, b
}
