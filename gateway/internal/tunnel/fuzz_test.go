package tunnel

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path"
	"strings"
	"testing"
)

func quiet(f *testing.F) {
	orig := log.Writer()
	log.SetOutput(io.Discard)
	f.Cleanup(func() { log.SetOutput(orig) })
}

// FuzzServeFrame: a frame that isn't JSON or carries a body over MaxBody is
// refused (400/413) before any handler runs; any other reaches the handler as
// sent and, the handler writing nothing, answers 200. Either way: one status.
func FuzzServeFrame(f *testing.F) {
	for _, rq := range []tunnelReq{
		{Method: "GET", URL: "/Videos/" + vid + "/hls1/main/0.ts", Headers: map[string]string{"Range": "bytes=0-99"}},
		{Method: "POST", URL: "/Items/" + vid + "/PlaybackInfo", Body: `{"a":1}`},
		{Method: "POST", URL: "/UserItems/" + vid + "/UserData", Body: strings.Repeat("x", MaxBody+1)},
		{Method: "GET", URL: "/Items%zz"},
		{Method: "GET", URL: "//evil.example/UserViews"},
		{Method: "", URL: ""},
	} {
		raw, _ := json.Marshal(rq)
		f.Add(raw)
	}
	f.Add([]byte(`not json`))
	f.Add([]byte(`{"method":1}`))
	quiet(f)
	f.Fuzz(func(t *testing.T, raw []byte) {
		var rq tunnelReq
		refused := json.Unmarshal(raw, &rq) != nil || len(rq.Body) > MaxBody
		called := false
		h := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			called = true
			b, _ := io.ReadAll(r.Body)
			if r.Method != rq.Method || r.RequestURI != rq.URL || string(b) != rq.Body {
				t.Errorf("handler got %s %q (%d bytes), frame said %s %q (%d bytes)",
					r.Method, r.RequestURI, len(b), rq.Method, rq.URL, len(rq.Body))
			}
		})
		w := &heads{ResponseRecorder: httptest.NewRecorder()}
		serve(w, h, raw, &reqState{})
		if w.n != 1 {
			t.Errorf("%d statuses written for %q", w.n, raw)
		}
		switch {
		case refused && called:
			t.Errorf("refused frame reached the handler: %q", raw)
		case refused && w.Code != http.StatusBadRequest && w.Code != http.StatusRequestEntityTooLarge:
			t.Errorf("refused frame answered %d", w.Code)
		case !refused && !called:
			t.Errorf("frame never reached the handler (%d): %q", w.Code, raw)
		case !refused && w.Code != http.StatusOK:
			t.Errorf("silent handler answered %d", w.Code)
		}
	})
}

// heads counts WriteHeader calls: the recorder keeps only the first.
type heads struct {
	*httptest.ResponseRecorder
	n int
}

func (w *heads) WriteHeader(code int) { w.n++; w.ResponseRecorder.WriteHeader(code) }

// FuzzJellyfinPolicy: a request the policy lets through goes to Jellyfin only,
// on a clean allowlisted path, with the gateway's token and none of the
// browser's credentials, pinned to the session's viewer.
func FuzzJellyfinPolicy(f *testing.F) {
	for _, c := range [][2]string{
		{"GET", "/UserViews"},
		{"GET", "/Items?parentId=" + vid + "&recursive=true&api_key=a&ApiKey=b&USERID=c"},
		{"GET", "/Items/" + vid + "/Images/Primary?maxWidth=300"},
		{"POST", "/Items/" + vid + "/PlaybackInfo"},
		{"POST", "/UserItems/" + vid + "/UserData"},
		{"GET", "/Videos/" + vid + "/master.m3u8?mediaSourceId=" + vid},
		{"GET", "/videos/7a3ef65e-2921-cba5-c000-93ee87cf13e1/master.m3u8?MediaSourceId=" + vid},
		{"GET", "/Videos/" + vid + "/../../Auth/Keys"},
		{"GET", "/Videos/" + vid + "/%2e%2e/%2e%2e/Auth/Keys"},
		{"GET", "/Videos/" + vid + "/hls%2Fmain.m3u8"},
		{"GET", "/Videos/" + vid + "//x"},
		{"GET", "http://evil.example/UserViews"},
		{"GET", "//user@evil.example/UserViews"},
		{"GET", "/UserView%73"},
		{"GET", "/It\x00ems"},
		{"DELETE", "/Items/" + vid},
	} {
		for _, hdr := range []string{"Range", "X-Emby-Authorization", "x-MediaBrowser-Client", "COOKIE", "accept-encoding"} {
			f.Add(c[0], c[1], hdr, "v")
		}
	}
	quiet(f)
	f.Fuzz(func(t *testing.T, method, uri, hdrName, hdrVal string) {
		r := &http.Request{Method: method, RequestURI: uri, Body: http.NoBody, Header: http.Header{
			"Authorization":        {`MediaBrowser Token="browser"`},
			"Cookie":               {"browser"},
			"X-Emby-Token":         {"browser"},
			"X-Mediabrowser-Token": {"browser"},
		}}
		r.Header[hdrName] = []string{hdrVal} // raw key: any spelling
		req, _, err := (&Jellyfin{URL: "http://jellyfin.test"}).prepare(r, cred{key, uid})
		if err != nil {
			return
		}
		checkOrigin(t, method, uri, req)
	})
}

func checkOrigin(t *testing.T, method, uri string, req *http.Request) {
	u := req.URL
	p := u.Path
	if u.Host != "jellyfin.test" || u.User != nil {
		t.Errorf("%s %q went to %q", method, uri, u.Redacted())
	}
	if p != path.Clean(p) || strings.Contains(p, "//") || strings.Contains(p, "%") || u.RawPath != "" ||
		!allow(method, p) {
		t.Errorf("%s %q passed as path %q (raw %q)", method, uri, p, u.RawPath)
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." || seg == "." {
			t.Errorf("%s %q passed with a %q segment", method, uri, seg)
		}
	}
	for k, vs := range req.Header {
		switch lk := strings.ToLower(k); {
		case lk == "authorization":
			if len(vs) != 1 || vs[0] != `MediaBrowser Token="`+key+`"` {
				t.Errorf("%s %q: Authorization %q", method, uri, vs)
			}
		case lk == "cookie", lk == "accept-encoding",
			strings.HasPrefix(lk, "x-emby"), strings.HasPrefix(lk, "x-mediabrowser"):
			t.Errorf("%s %q: browser header %s reached Jellyfin", method, uri, k)
		}
	}
	if req.Header.Get("Authorization") == "" {
		t.Errorf("%s %q: no token", method, uri)
	}
	q, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		t.Errorf("%s %q: query %q: %v", method, uri, u.RawQuery, err)
	}
	for k, vs := range q {
		switch strings.ToLower(k) {
		case "api_key", "apikey":
			t.Errorf("%s %q: %s reached Jellyfin", method, uri, k)
		case "userid":
			if k != "userId" || len(vs) != 1 || vs[0] != uid {
				t.Errorf("%s %q: %s=%q, want userId=%s", method, uri, k, vs, uid)
			}
		}
	}
	if q.Get("userId") != uid {
		t.Errorf("%s %q: not pinned to the viewer: %q", method, uri, u.RawQuery)
	}
}
