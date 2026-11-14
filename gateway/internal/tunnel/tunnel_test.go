package tunnel

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
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
		{"GET", "//evil.example/UserViews", false}, // scheme-relative: a host, no scheme
		{"GET", "//user@evil.example/UserViews", false},
		{"GET", "/Items/not-an-id", false},
	} {
		j, _ := fakeJellyfin(t)
		raw, _ := json.Marshal(tunnelReq{Method: c.method, URL: c.url})
		status, _, body, err := proxy(j, raw, Session{})
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
	if status, _, _, err := proxy(j, raw, Session{}); status != http.StatusRequestEntityTooLarge || err == nil {
		t.Fatalf("oversized body: status %d", status)
	}
}

// No token (or a token without its user) refuses instead of guessing a user.
func TestNoToken(t *testing.T) {
	j, _ := fakeJellyfin(t)
	raw, _ := json.Marshal(tunnelReq{Method: "GET", URL: "/UserViews"})
	for _, c := range []struct{ key, user string }{{"", ""}, {key, ""}, {"", uid}} {
		j.SetKey(c.key, c.user)
		if status, _, _, _ := proxy(j, raw, Session{}); status != http.StatusServiceUnavailable {
			t.Errorf("SetKey(%q, %q): status %d, want 503", c.key, c.user, status)
		}
	}
}

// The burst endpoint (#90) is served by the gateway itself: no Jellyfin call,
// works without a token, size defaults and is capped; other methods/paths don't hit it.
func TestBurst(t *testing.T) {
	j, last := fakeJellyfin(t)
	j.SetKey("", "") // no Jellyfin token needed
	status, hdr, body := do(t, j, tunnelReq{Method: "GET", URL: BurstPath})
	if status != 200 || len(body) != BurstDefault || hdr["Content-Length"] != fmt.Sprint(BurstDefault) || last.URL != nil {
		t.Fatalf("default burst = %d, %d bytes, %v, jellyfin hit %v", status, len(body), hdr, last.URL)
	}
	if status, _, body := do(t, j, tunnelReq{Method: "GET", URL: BurstPath + "?size=1000"}); status != 200 || len(body) != 1000 {
		t.Fatalf("size=1000 = %d, %d bytes", status, len(body))
	}
	for _, rq := range []tunnelReq{
		{Method: "GET", URL: fmt.Sprintf("%s?size=%d", BurstPath, BurstMax+1)},
		{Method: "GET", URL: BurstPath + "?size=-1"},
		{Method: "GET", URL: BurstPath + "?size=lots"},
	} {
		raw, _ := json.Marshal(rq)
		if status, _, _, err := proxy(j, raw, Session{}); status != http.StatusBadRequest || err == nil {
			t.Errorf("%s: status %d, want 400", rq.URL, status)
		}
	}
	// The largest burst is generated chunk by chunk, never allocated whole.
	raw, _ := json.Marshal(tunnelReq{Method: "GET", URL: fmt.Sprintf("%s?size=%d", BurstPath, BurstMax)})
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	_, _, big, err := proxy(j, raw, Session{})
	if err != nil {
		t.Fatal(err)
	}
	n, _ := io.Copy(io.Discard, big)
	runtime.ReadMemStats(&after)
	if alloc := after.TotalAlloc - before.TotalAlloc; n != BurstMax || alloc > BurstMax/4 {
		t.Fatalf("size=%d burst = %d bytes, %d bytes allocated", BurstMax, n, alloc)
	}
	for _, rq := range []tunnelReq{{Method: "POST", URL: BurstPath}, {Method: "GET", URL: "/streamiq/%62urst"}} {
		raw, _ := json.Marshal(rq)
		if status, _, _, _ := proxy(j, raw, Session{}); status == 200 {
			t.Errorf("%s %s: got 200", rq.Method, rq.URL)
		}
	}
}

// The gateway API (#146): /streamiq/* is answered by the gateway, never
// Jellyfin (any spelling of the prefix, any method), unknown paths are 404, and
// status is built per request without a Jellyfin token.
func TestGatewayAPI(t *testing.T) {
	j, last := fakeJellyfin(t)
	j.SetKey("", "")
	n := 0
	j.Status = func() any { n++; return map[string]any{"transcoding": "nvenc"} }
	status, hdr, body := do(t, j, tunnelReq{Method: "GET", URL: StatusPath})
	if status != 200 || hdr["Content-Type"] != "application/json" || string(body) != `{"transcoding":"nvenc"}` || n != 1 {
		t.Fatalf("status = %d %v %s (built %d times)", status, hdr, body, n)
	}
	j.SetKey(key, uid) // a token would let a forwarded request through: none may be
	for _, rq := range []tunnelReq{
		{Method: "GET", URL: "/streamiq/nope"},
		{Method: "GET", URL: "/streamiq"},
		{Method: "GET", URL: "/StreamIQ/status"},
		{Method: "GET", URL: "/streamiq/%73tatus"},
		{Method: "POST", URL: StatusPath, Body: "{}"},
		{Method: "GET", URL: "/streamiq/../streamiq/status"},
	} {
		raw, _ := json.Marshal(rq)
		if status, _, _, _ := proxy(j, raw, Session{}); status != http.StatusNotFound {
			t.Errorf("%s %s: status %d, want 404", rq.Method, rq.URL, status)
		}
	}
	if last.URL != nil || n != 1 {
		t.Fatalf("jellyfin hit %v, status built %d times", last.URL, n)
	}
}

func do(t *testing.T, j *Jellyfin, rq tunnelReq) (int, map[string]string, []byte) {
	t.Helper()
	raw, _ := json.Marshal(rq)
	status, hdr, body, err := proxy(j, raw, Session{})
	if err != nil {
		t.Fatalf("proxy %s %s: %v", rq.Method, rq.URL, err)
	}
	defer body.Close()
	b, _ := io.ReadAll(body)
	return status, hdr, b
}

// An endpoint marked admin-only (#194) answers a household admin and refuses a
// member (or a session without a role) with 403; unmarked ones answer both.
func TestAdminOnly(t *testing.T) {
	j, _ := fakeJellyfin(t)
	j.Status = func() any { return map[string]any{} }
	call := func(role, path string) int {
		raw, _ := json.Marshal(tunnelReq{Method: "GET", URL: path})
		status, _, body, _ := proxy(j, raw, Session{Role: role})
		if body != nil {
			body.Close()
		}
		return status
	}
	AdminOnly.Store(StatusPath, true)
	t.Cleanup(func() { AdminOnly.Delete(StatusPath) })
	for _, c := range []struct {
		role, path string
		want       int
	}{
		{Admin, StatusPath, 200},
		{Member, StatusPath, http.StatusForbidden},
		{"", StatusPath, http.StatusForbidden},
		{Member, BurstPath + "?size=1", 200},
		{Admin, BurstPath + "?size=1", 200},
	} {
		if got := call(c.role, c.path); got != c.want {
			t.Errorf("%q GET %s: status %d, want %d", c.role, c.path, got, c.want)
		}
	}
}

// A response blocked on a full send buffer (the browser stopped reading) ends
// when its channel or connection does: the send loop returns, the upstream
// response is closed and the channel's slot is free again.
func TestBlockedStreamEndsOnClose(t *testing.T) {
	for name, end := range map[string]func(browser, gateway *webrtc.PeerConnection, d *webrtc.DataChannel){
		"browser closes the channel":    func(_, _ *webrtc.PeerConnection, d *webrtc.DataChannel) { d.Close() },
		"browser closes the connection": func(b, _ *webrtc.PeerConnection, _ *webrtc.DataChannel) { b.Close() },
		"gateway closes the connection": func(_, g *webrtc.PeerConnection, _ *webrtc.DataChannel) { g.Close() }, // sessions.Drop
	} {
		t.Run(name, func(t *testing.T) {
			upstreamDone := make(chan struct{})
			origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(upstreamDone)
				w.Header().Set("Content-Type", "video/mp2t")
				for buf := make([]byte, ChunkSize); r.Context().Err() == nil; {
					if _, err := w.Write(buf); err != nil { // endless: only a closed response body ends it
						return
					}
				}
			}))
			t.Cleanup(origin.Close)
			j := &Jellyfin{Client: http.DefaultClient, URL: origin.URL}
			j.SetKey(key, uid)

			browser, _ := webrtc.NewPeerConnection(webrtc.Configuration{})
			gateway, _ := webrtc.NewPeerConnection(webrtc.Configuration{})
			hold := make(chan struct{})
			t.Cleanup(func() { close(hold); browser.Close(); gateway.Close() })
			slots := make(chan struct{}, MaxChannels)
			served := make(chan *webrtc.DataChannel, 1)
			gateway.OnDataChannel(func(d *webrtc.DataChannel) {
				Serve(d, j, Session{}, slots)
				served <- d
			})
			d, _ := browser.CreateDataChannel("req", nil)
			d.OnOpen(func() { d.SendText(`{"method":"GET","url":"/Videos/` + vid + `/hls1/main/0.ts"}`) })
			d.OnMessage(func(webrtc.DataChannelMessage) { <-hold }) // never reads on: the gateway's send buffer fills

			offer, _ := browser.CreateOffer(nil)
			gathered := webrtc.GatheringCompletePromise(browser)
			browser.SetLocalDescription(offer)
			<-gathered
			gateway.SetRemoteDescription(*browser.LocalDescription())
			answer, _ := gateway.CreateAnswer(nil)
			gathered = webrtc.GatheringCompletePromise(gateway)
			gateway.SetLocalDescription(answer)
			<-gathered
			browser.SetRemoteDescription(*gateway.LocalDescription())

			var gd *webrtc.DataChannel
			select {
			case gd = <-served:
			case <-time.After(30 * time.Second):
				t.Fatal("no data channel on the gateway")
			}
			// Waiting on backpressure: the buffer went over MaxBuffered and now sits,
			// unchanged, above the low-water mark that would wake the sender.
			for start, was := time.Now(), uint64(0); ; was = gd.BufferedAmount() {
				if was > MaxBuffered/2 && was == gd.BufferedAmount() {
					break
				}
				if time.Since(start) > 30*time.Second {
					t.Fatalf("sender never blocked (%d bytes buffered)", gd.BufferedAmount())
				}
				time.Sleep(300 * time.Millisecond)
			}
			select {
			case <-upstreamDone:
				t.Fatal("upstream ended before the channel closed")
			default:
			}

			go end(browser, gateway, d)
			select {
			case <-upstreamDone:
			case <-time.After(30 * time.Second):
				t.Fatal("sender still blocked after the close: upstream response never closed")
			}
			for start := time.Now(); len(slots) != 0; time.Sleep(10 * time.Millisecond) {
				if time.Since(start) > 10*time.Second {
					t.Fatal("slot not given back")
				}
			}
		})
	}
}

// Each session's requests carry its user's own viewer token and userId (#195);
// a user without one gets the shared viewer. Each token is redacted.
func TestPerUserViewer(t *testing.T) {
	var auth, user string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth, user = r.Header.Get("Authorization"), r.URL.Query().Get("userId")
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		_, tok, _ := strings.Cut(auth, `Token="`)
		w.Write([]byte("sub.vtt?ApiKey=" + strings.TrimSuffix(tok, `"`)))
	}))
	t.Cleanup(srv.Close)
	j := &Jellyfin{Client: http.DefaultClient, URL: srv.URL, Viewer: func(u string) (string, string) {
		if u == "alice" {
			return "alicetoken", "alice-jf-id"
		}
		return "", ""
	}}
	j.SetKey(key, uid)
	raw, _ := json.Marshal(tunnelReq{Method: "GET", URL: "/Videos/" + vid + "/main.m3u8"})
	for _, c := range []struct{ user, tok, id string }{{"alice", "alicetoken", "alice-jf-id"}, {"bob", key, uid}, {"", key, uid}} {
		status, _, body, err := proxy(j, raw, Session{User: c.user})
		if err != nil || status != 200 {
			t.Fatalf("%s: %d %v", c.user, status, err)
		}
		b, _ := io.ReadAll(body)
		if auth != `MediaBrowser Token="`+c.tok+`"` || user != c.id || string(b) != "sub.vtt?ApiKey=redacted" {
			t.Fatalf("%s: forwarded %q userId %q, body %q", c.user, auth, user, b)
		}
	}
}

// A body cut off upstream ends in an error frame, never the EOF frame that
// would pass it off as complete (#263).
func TestCutOffBodyEndsInError(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp2t")
		w.Header().Set("Content-Length", "100000")
		w.Write(make([]byte, 10000))
		w.(http.Flusher).Flush()
		c, _, _ := w.(http.Hijacker).Hijack() // drop the connection 90000 bytes short
		c.Close()
	}))
	t.Cleanup(origin.Close)
	j := &Jellyfin{Client: http.DefaultClient, URL: origin.URL}
	j.SetKey(key, uid)

	browser, _ := webrtc.NewPeerConnection(webrtc.Configuration{})
	gateway, _ := webrtc.NewPeerConnection(webrtc.Configuration{})
	t.Cleanup(func() { browser.Close(); gateway.Close() })
	gateway.OnDataChannel(func(d *webrtc.DataChannel) { Serve(d, j, Session{}, make(chan struct{}, 1)) })
	d, _ := browser.CreateDataChannel("req", nil)
	d.OnOpen(func() { d.SendText(`{"method":"GET","url":"/Videos/` + vid + `/hls1/main/0.ts"}`) })
	texts := make(chan string, 4)
	d.OnMessage(func(m webrtc.DataChannelMessage) {
		if m.IsString {
			texts <- string(m.Data)
		}
	})

	offer, _ := browser.CreateOffer(nil)
	gathered := webrtc.GatheringCompletePromise(browser)
	browser.SetLocalDescription(offer)
	<-gathered
	gateway.SetRemoteDescription(*browser.LocalDescription())
	answer, _ := gateway.CreateAnswer(nil)
	gathered = webrtc.GatheringCompletePromise(gateway)
	gateway.SetLocalDescription(answer)
	<-gathered
	browser.SetRemoteDescription(*gateway.LocalDescription())

	for i := 0; i < 2; i++ { // head, then the end frame
		select {
		case s := <-texts:
			if i == 1 && !strings.HasPrefix(s, `{"error":`) {
				t.Fatalf("end frame = %s, want an error frame", s)
			}
		case <-time.After(30 * time.Second):
			t.Fatalf("frame %d never arrived", i)
		}
	}
}
