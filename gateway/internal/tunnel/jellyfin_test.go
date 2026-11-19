package tunnel

import (
	"net/http"
	"net/url"
	"testing"
)

func TestOriginURLRefuses(t *testing.T) {
	for name, uri := range map[string]string{
		"unparsable":    "/Items%zz",
		"absolute":      "http:/Items",
		"host":          "//evil.example/Items",
		"user info":     "//u:p@/Items",
		"escaped path":  "/Videos/" + uid + "/hls%2Fmain.m3u8",
		"unclean path":  "/Videos/" + uid + "/./main.m3u8",
		"double slash":  "//Items",
		"not allowed":   "/System/Configuration",
		"wrong method":  "/Items/" + uid + "/PlaybackInfo",
		"control chars": "/It\x00ems",
	} {
		r := &http.Request{Method: "GET", RequestURI: uri}
		if u, err := originURL(r, "u1"); err == nil {
			t.Errorf("%s: %q passed as %v", name, uri, u)
		} else if want := "refused GET " + uri; err.Error() != want {
			t.Errorf("%s: error %q, want %q", name, err, want)
		}
	}
}

func TestOriginURLRewritesQuery(t *testing.T) {
	r := &http.Request{
		Method:     "GET",
		RequestURI: "/Items?ParentId=p&api_key=a&ApiKey=b&APIKEY=c&userId=x&USERID=y&UserID=z",
	}
	u, err := originURL(r, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if u.Path != "/Items" {
		t.Errorf("path %q", u.Path)
	}
	want := url.Values{"ParentId": {"p"}, "userId": {"u1"}}
	if got := u.Query(); got.Encode() != want.Encode() {
		t.Errorf("query %q, want %q", got.Encode(), want.Encode())
	}
}

func TestCopyHeaders(t *testing.T) {
	src := http.Header{}
	for _, k := range []string{"authorization", "COOKIE", "X-Emby-Token", "x-emby-authorization",
		"X-MEDIABROWSER-TOKEN", "x-MediaBrowser-Client", "ACCEPT-encoding"} {
		src[k] = []string{"secret"} // raw keys: keep the mixed case
	}
	src["range"] = []string{"bytes=0-", "ignored"}
	dst := http.Header{}
	copyHeaders(dst, src)
	if len(dst) != 1 || dst.Get("Range") != "bytes=0-" || len(dst["Range"]) != 1 {
		t.Errorf("got %v, want only Range: bytes=0-", dst)
	}
}
