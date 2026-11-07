package localpage

import (
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"html/template"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const cookieName = "streamiq_page"

// Token loads the page token from state/page-token, creating it on first start,
// and writes the login link (lanURL + ?t=token) to state/page-link for the
// installer to print. The link is rewritten on every start: the LAN IP can
// change. Neither file is logged. Rotate = delete page-token + restart.
func Token(stateDir, lanURL string) (string, error) {
	path := filepath.Join(stateDir, "page-token")
	b, err := os.ReadFile(path)
	tok := strings.TrimSpace(string(b))
	if errors.Is(err, fs.ErrNotExist) || (err == nil && tok == "") {
		tok = rand.Text() + rand.Text() // 2×128 bits, base32
		err = os.WriteFile(path, []byte(tok+"\n"), 0o600)
	}
	if err != nil {
		return "", err
	}
	return tok, os.WriteFile(filepath.Join(stateDir, "page-link"), []byte(lanURL+"/?t="+tok+"\n"), 0o600)
}

var loginForm = template.Must(template.New("login").Parse(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>StreamIQ gateway</title>
<body style="font-family:system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem">
<h1>StreamIQ gateway</h1>
{{if .}}<p style="color:#c00">Wrong token.</p>{{end}}
<form method="get" action="/">
<p>Open the link the installer printed, or paste the token from <code>page-token</code>
in the gateway's state folder.</p>
<p><input name="t" placeholder="Token" required autocomplete="off" size="40"> <button>Open</button></p>
</form>
</body>`))

// Auth gates the page behind the token: a valid ?t= sets a cookie and redirects
// (drops the token from the address bar); otherwise the cookie must match.
// Loopback skips it: whoever sits at the machine can read state/ anyway.
// ponytail: a reverse proxy on the same machine would look like loopback; none is supported.
func Auth(token string, h http.Handler) http.Handler {
	ok := func(s string) bool { return subtle.ConstantTimeCompare([]byte(s), []byte(token)) == 1 }
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ip, _, err := net.SplitHostPort(r.RemoteAddr); err == nil && net.ParseIP(ip).IsLoopback() {
			h.ServeHTTP(w, r)
			return
		}
		if t := r.URL.Query().Get("t"); t != "" && r.Method == http.MethodGet {
			if ok(t) {
				// No Secure: the page is plain HTTP on a LAN IP, and browsers drop Secure
				// cookies from http:// origins (login would loop). HTTPS on the LAN is out
				// of scope (#42); the cookie is sniffable on shared Wi-Fi, accepted.
				http.SetCookie(w, &http.Cookie{Name: cookieName, Value: token, Path: "/",
					MaxAge: 365 * 24 * 3600, HttpOnly: true, SameSite: http.SameSiteStrictMode})
				http.Redirect(w, r, "/", http.StatusSeeOther)
				return
			}
		} else if c, err := r.Cookie(cookieName); err == nil && ok(c.Value) {
			h.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet {
			http.Error(w, "sign in to the gateway page first", http.StatusForbidden)
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
		loginForm.Execute(w, r.URL.Query().Has("t"))
	})
}
