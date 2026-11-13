// Package localpage is the gateway's page on the home LAN (default :8097): the
// only place a browser can be approved, so it refuses cross-site and
// DNS-rebinding requests.
package localpage

import (
	"context"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"streamiq/gateway/internal/pairing"
)

// Guard protects the page. Host must be an IP literal, localhost, or the
// configured LAN host (blocks DNS rebinding); state-changing requests must come
// from the page's own origin (blocks drive-by approval from a malicious site).
func Guard(lanHost string, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if hh, _, err := net.SplitHostPort(r.Host); err == nil {
			host = hh
		}
		if net.ParseIP(strings.Trim(host, "[]")) == nil && host != "localhost" && host != lanHost {
			http.Error(w, "bad host", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("Origin") != "http://"+r.Host {
			http.Error(w, "cross-origin request refused", http.StatusForbidden)
			return
		}
		h.ServeHTTP(w, r)
	})
}

var page = template.Must(template.New("page").Parse(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
{{if not .Jellyfin.NeedsLogin}}<meta http-equiv="refresh" content="3">{{end}}
<title>StreamIQ gateway · {{.Name}}</title>
<body style="font-family:system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem">
<h1>StreamIQ gateway · {{.Name}}</h1>
<h2>Status</h2>
<ul>
<li>Version <code>{{.Version}}</code>{{with .Update}} · <b style="color:#06c">update available: {{.}}</b>{{end}}</li>
<li>StreamIQ: {{if .LastBeat}}<b>connected</b> · last heartbeat {{.LastBeat.Format "15:04:05"}}{{else}}<b style="color:#c00">not connected</b>{{end}}</li>
{{with .Jellyfin}}
<li>Jellyfin: {{if .Reachable}}<b>reachable</b> · version {{.Version}}
{{if .Untested}} · <b style="color:#c80">not tested with this gateway (tested: {{.Tested}}.x)</b>{{end}}
{{else}}<b style="color:#c00">not reachable</b>{{end}}
· token: {{if .LegacyKey}}<b style="color:#c80">admin API key: reconnect Jellyfin</b>{{else if .HasKey}}<b>set</b> (user {{.Viewer}}){{else}}<b style="color:#c00">missing</b>, playback refused{{end}}</li>
{{if .HasKey}}<li>Transcoding settings: {{if .Managed}}<b>managed</b> · hardware acceleration {{or .HWAccel "off"}}
(<code>STREAMIQ_JELLYFIN_HWACCEL</code> in gateway.env){{else}}not managed (your Jellyfin: Dashboard → Playback → Transcoding){{end}}</li>{{end}}
{{if .Err}}<li style="color:#c00">{{.Err}}</li>{{end}}
{{end}}
</ul>
{{with .Jellyfin}}{{if .PasswordFile}}
<p style="border:2px solid #888;padding:.5rem 1rem">This gateway set up Jellyfin. Jellyfin admin:
<b>{{.User}}</b> · password in <code>{{.PasswordFile}}</code> (open it on this computer)</p>{{end}}
{{if .NeedsLogin}}
<form method="post" action="/jellyfin/login" style="border:2px solid #c80;padding:.5rem 1rem">
<p><b>Connect Jellyfin.</b> Sign in once with a Jellyfin administrator. The gateway uses it to
create the hidden, non-admin user <code>streamiq-viewer</code> and streams as that user (its own
watch progress), and to create its own hidden admin <code>streamiq-admin</code> (password stored on this
computer) for per-member users later. Your password is not stored.</p>
<p><input name="user" placeholder="Jellyfin user" required autocomplete="username">
<input name="pw" type="password" placeholder="Password" autocomplete="current-password">
<button>Connect</button></p>
</form>{{end}}{{end}}
<h2>Pairing requests</h2>
{{range .Pending}}
<form method="post" action="/decide" style="border:2px solid #c80;padding:.5rem 1rem;margin:.5rem 0">
<p><b>{{.Name}}</b> wants to pair · code <b style="font-size:1.6em;letter-spacing:.1em">{{.Code}}</b></p>
<p>Approve only if your browser shows the same code.</p>
<input type="hidden" name="id" value="{{.ID}}">
<button name="approve" value="1">Approve</button> <button name="approve" value="0">Reject</button>
</form>
{{else}}<p>None. Press <i>Pair this browser</i> in the web app.</p>{{end}}
<h2>Paired browsers</h2>
{{range .Paired}}
<form method="post" action="/remove"><input type="hidden" name="keyFp" value="{{.KeyFp}}">
{{.Name}} <small>(since {{.AddedAt.Format "2006-01-02"}})</small> <button>Remove</button></form>
{{else}}<p>None yet.</p>{{end}}
<p><small>Gateway id: <code>{{.GatewayID}}</code><br>
DTLS fingerprint (browsers pin this):<br><code style="word-break:break-all">{{.Fingerprint}}</code></small></p>
</body>`))

// Config is what the page shows and drives.
type Config struct {
	Name, GatewayID, Fingerprint, Version string
	LastBeat                              *atomic.Int64           // unix time of the last heartbeat, 0 = disconnected
	Update                                *atomic.Pointer[string] // update notice, "" = up to date
	Store                                 *pairing.Store
	Jellyfin                              func() any                                       // status snapshot (jellyfin.View)
	Login                                 func(ctx context.Context, user, pw string) error // connect Jellyfin (viewer token)
}

// Handler renders the status page and takes the Approve/Reject/Remove and
// Jellyfin login posts. Only someone on the home LAN reaches it, and Guard
// stops other sites driving it.
func Handler(c Config) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		var beat any // nil renders "not connected"
		if t := c.LastBeat.Load(); t != 0 {
			beat = time.Unix(t, 0)
		}
		page.Execute(w, map[string]any{
			"Name": c.Name, "GatewayID": c.GatewayID, "Fingerprint": c.Fingerprint,
			"Version": c.Version, "Update": *c.Update.Load(), "LastBeat": beat,
			"Jellyfin": c.Jellyfin(), "Pending": c.Store.Pending(), "Paired": c.Store.Paired(),
		})
	})
	// For `gateway status` on this machine. Loopback only, even with a page
	// cookie: it's a machine-local API, not part of the LAN page.
	mux.HandleFunc("GET /status.json", func(w http.ResponseWriter, r *http.Request) {
		if ip, _, err := net.SplitHostPort(r.RemoteAddr); err != nil || !net.ParseIP(ip).IsLoopback() {
			http.Error(w, "loopback only", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Status{
			Name: c.Name, Version: c.Version, Update: *c.Update.Load(),
			LastBeat: c.LastBeat.Load(), Jellyfin: c.Jellyfin(),
		})
	})
	mux.HandleFunc("POST /jellyfin/login", func(w http.ResponseWriter, r *http.Request) {
		if err := c.Login(r.Context(), r.FormValue("user"), r.FormValue("pw")); err != nil {
			http.Error(w, "Jellyfin sign-in failed: "+err.Error(), http.StatusBadRequest)
			return
		}
		http.Redirect(w, r, "/", http.StatusSeeOther)
	})
	mux.HandleFunc("POST /decide", func(w http.ResponseWriter, r *http.Request) {
		if err := c.Store.Decide(r.FormValue("id"), r.FormValue("approve") == "1"); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		http.Redirect(w, r, "/", http.StatusSeeOther)
	})
	mux.HandleFunc("POST /remove", func(w http.ResponseWriter, r *http.Request) {
		if err := c.Store.Remove(r.FormValue("keyFp")); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		http.Redirect(w, r, "/", http.StatusSeeOther)
	})
	return mux
}

// Status is GET /status.json. Jellyfin is jellyfin.View (this slice doesn't
// import it); PrintStatus reads the fields it shows.
type Status struct {
	Name, Version, Update string
	LastBeat              int64 // unix seconds, 0 = not connected
	Jellyfin              any
}

// PrintStatus asks the gateway running on this machine (page at
// http://127.0.0.1:port) for its status and prints it. pageLink is the LAN
// login link (state/page-link), "" if unknown.
func PrintStatus(ctx context.Context, w io.Writer, port, pageLink string) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://127.0.0.1:"+port+"/status.json", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("not running (nothing answers on port %s)", port)
	}
	defer res.Body.Close()
	var s struct {
		Status
		Jellyfin struct {
			Reachable, HasKey, LegacyKey, NeedsLogin bool
			Version, Err                             string
		}
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("port %s: HTTP %d (another program, or an older gateway: run `gateway update`)", port, res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(&s); err != nil {
		return fmt.Errorf("port %s: %w", port, err)
	}
	beat := "not connected"
	if s.LastBeat != 0 {
		beat = fmt.Sprintf("connected, last heartbeat %s ago", time.Since(time.Unix(s.LastBeat, 0)).Round(time.Second))
	}
	jf := "not reachable"
	if j := s.Jellyfin; j.Reachable {
		jf = "reachable, version " + j.Version + ", token "
		switch {
		case j.LegacyKey:
			jf += "admin API key (reconnect Jellyfin on the local page)"
		case j.HasKey:
			jf += "set"
		case j.NeedsLogin:
			jf += "missing (Connect Jellyfin on the local page)"
		default:
			jf += "missing"
		}
	}
	if s.Jellyfin.Err != "" {
		jf += " (" + s.Jellyfin.Err + ")"
	}
	upd := "up to date"
	if s.Update != "" {
		upd = "available: " + s.Update
	}
	fmt.Fprintf(w, "gateway    %s, version %s\nupdate     %s\nStreamIQ   %s\nJellyfin   %s\nlocal page http://localhost:%s\n",
		s.Name, s.Version, upd, beat, jf, port)
	if pageLink != "" {
		fmt.Fprintf(w, "           from another device: %s\n", pageLink)
	}
	return nil
}
