package localpage

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAuth(t *testing.T) {
	h := Auth("secret", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("page")) }))
	do := func(method, target, remote, cookie string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, target, nil)
		r.RemoteAddr = remote
		if cookie != "" {
			r.AddCookie(&http.Cookie{Name: cookieName, Value: cookie})
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	lan := "192.168.1.30:5555"
	cases := []struct {
		name                           string
		method, target, remote, cookie string
		want                           int
		body                           string
	}{
		{"LAN no cookie shows form", "GET", "/", lan, "", 401, `name="t"`},
		{"LAN post no cookie", "POST", "/remove", lan, "", 403, ""},
		{"LAN wrong cookie", "POST", "/remove", lan, "nope", 403, ""},
		{"LAN good cookie", "GET", "/", lan, "secret", 200, "page"},
		{"LAN good cookie post", "POST", "/remove", lan, "secret", 200, "page"},
		{"wrong token", "GET", "/?t=nope", lan, "", 401, "Wrong token"},
		{"loopback v4", "POST", "/remove", "127.0.0.1:5555", "", 200, "page"},
		{"loopback v6", "GET", "/", "[::1]:5555", "", 200, "page"},
	}
	for _, c := range cases {
		w := do(c.method, c.target, c.remote, c.cookie)
		if w.Code != c.want || !strings.Contains(w.Body.String(), c.body) {
			t.Errorf("%s: %d %q, want %d containing %q", c.name, w.Code, w.Body, c.want, c.body)
		}
	}

	w := do("GET", "/?t=secret", lan, "")
	ck := w.Result().Cookies()
	if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/" || len(ck) != 1 ||
		ck[0].Value != "secret" || !ck[0].HttpOnly || ck[0].SameSite != http.SameSiteStrictMode {
		t.Fatalf("valid link: %d %v %v", w.Code, w.Header(), ck)
	}
	if w := do("GET", "/?t=nope", lan, ""); len(w.Result().Cookies()) != 0 {
		t.Fatal("wrong token set a cookie")
	}
}

// Token survives restarts (cookies stay valid), the link follows the LAN URL,
// and deleting page-token rotates it.
func TestToken(t *testing.T) {
	dir := t.TempDir()
	a, err := Token(dir, "http://192.168.1.5:8097")
	if err != nil || len(a) < 40 {
		t.Fatalf("token %q, %v", a, err)
	}
	b, _ := Token(dir, "http://192.168.1.9:8097")
	link, _ := os.ReadFile(filepath.Join(dir, "page-link"))
	if a != b || string(link) != "http://192.168.1.9:8097/?t="+a+"\n" {
		t.Fatalf("restart: %q vs %q, link %q", a, b, link)
	}
	os.Remove(filepath.Join(dir, "page-token"))
	if c, _ := Token(dir, "http://x"); c == a {
		t.Fatal("not rotated")
	}
}
