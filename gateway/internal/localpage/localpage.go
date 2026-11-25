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
	"log"
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
		// Never in a frame: Approve must not be clickable through another site.
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
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
· token: {{if .HasKey}}<b>set</b> (user {{.Viewer}}){{else}}<b style="color:#c00">missing</b>, playback refused{{end}}</li>
{{if and .Managed $.Libraries}}<li><a href="/libraries">Libraries</a>: offline state and extras</li>{{end}}
{{if .HasKey}}<li>Transcoding settings: {{if .Managed}}<b>managed</b> · hardware acceleration {{or .HWAccel "off"}}
(<code>STREAMIQ_JELLYFIN_HWACCEL</code> in gateway.env){{else}}not managed (your Jellyfin: Dashboard → Playback → Transcoding){{end}}</li>{{end}}
{{if .Err}}<li style="color:#c00">{{.Err}}</li>{{end}}
{{end}}
{{with .Offline}}<li>{{if eq . "enforced"}}<b>Offline: enforced</b> (Jellyfin has no internet access){{else}}<b>Online lookups allowed</b>
(<code>gateway jellyfin offline on</code> cuts Jellyfin off; a file from before the jail: <code>gateway jellyfin upgrade</code>){{end}}</li>{{end}}
</ul>
{{with .Jellyfin}}{{if .PasswordFile}}
<p style="border:2px solid #888;padding:.5rem 1rem">This gateway set up Jellyfin. Jellyfin admin:
<b>{{.User}}</b> · password in <code>{{.PasswordFile}}</code> (open it on this computer)</p>{{end}}
{{if .NeedsLogin}}
<form method="post" action="/jellyfin/login" style="border:2px solid #c80;padding:.5rem 1rem">
{{if .Managed}}<p><b>Connect Jellyfin.</b> Sign in as the gateway's admin <code>{{.User}}</code>. Changed
its password in Jellyfin? Use the new one: the gateway stores it (in the file above), so it can make
members' Jellyfin users and apply its transcoding settings again. Signing in as another
administrator works too, but doesn't store that password.</p>
{{else}}<p><b>Connect Jellyfin.</b> Sign in once with a Jellyfin administrator. The gateway uses it to
create its own hidden admin <code>streamiq-admin</code> (password stored on this computer), which
makes a hidden, non-admin Jellyfin user per household member (their own watch progress), plus the
shared fallback <code>streamiq-viewer</code>. Your password is not stored.</p>{{end}}
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
Identity key (browsers pin this):<br><code style="word-break:break-all">{{.Fingerprint}}</code></small></p>
</body>`))

var libs = template.Must(template.New("libs").Parse(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>StreamIQ gateway · Libraries</title>
<body style="font-family:system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem">
<p><a href="/">← Gateway</a></p>
<h1>Libraries</h1>
<p><b>Offline</b>: Jellyfin looks nothing up online for this library (no metadata or image fetchers,
Screen Grabber included). Online lookups stay possible in Jellyfin: Dashboard → Libraries.
<b>Extras</b>: seek thumbnails (trickplay), chapter images and audio normalization (LUFS); StreamIQ
doesn't show them, and they cost CPU and disk.</p>
{{with .Err}}<p style="color:#c00">{{.}}</p>{{end}}
{{range .Libraries}}
<form method="post" style="border:1px solid #888;padding:.5rem 1rem;margin:.5rem 0">
<input type="hidden" name="id" value="{{.ID}}">
<p><b>{{.Name}}</b></p>
<p>{{if .Offline}}<b>Offline</b>{{else}}<b style="color:#c80">Online (set in Jellyfin)</b>
<button formaction="/libraries/offline">Make offline</button>{{end}}</p>
<p>Extras: <b>{{if eq .Extras "Custom"}}Custom (set in Jellyfin){{else}}{{.Extras}}{{end}}</b>
{{if eq .Extras "On"}}<button formaction="/libraries/extras" name="on" value="0">Turn off</button>
{{else}}<button formaction="/libraries/extras" name="on" value="1">Turn on</button>
{{if eq .Extras "Custom"}}<button formaction="/libraries/extras" name="on" value="0">Turn off</button>{{end}}{{end}}</p>
</form>
{{else}}{{if not .Err}}<p>No libraries yet. Add one in Jellyfin: Dashboard → Libraries.</p>{{end}}{{end}}
</body>`))

// Config is what the page shows and drives.
type Config struct {
	Name                            func() string // live: a rename shows without a restart
	GatewayID, Fingerprint, Version string
	LastBeat                        *atomic.Int64           // unix time of the last heartbeat, 0 = disconnected
	Update                          *atomic.Pointer[string] // update notice, "" = up to date
	Store                           *pairing.Store
	Jellyfin                        func() any                                       // status snapshot (jellyfin.View)
	Login                           func(ctx context.Context, user, pw string) error // connect Jellyfin (viewer token)
	Offline                         func() string                                    // jellyfin.Offline: "" = no line; nil = none
	// A managed Jellyfin's libraries (jellyfin.Setup's methods); nil = no list.
	Libraries   func(ctx context.Context) (any, error)
	MakeOffline func(ctx context.Context, id string) error
	SetExtras   func(ctx context.Context, id string, on bool) error
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
		logErr(page.Execute(w, map[string]any{
			"Name": c.Name(), "GatewayID": c.GatewayID, "Fingerprint": c.Fingerprint,
			"Version": c.Version, "Update": *c.Update.Load(), "LastBeat": beat,
			"Jellyfin": c.Jellyfin(), "Pending": c.Store.Pending(), "Paired": c.Store.Paired(),
			"Offline": offline(c), "Libraries": c.Libraries != nil,
		}))
	})
	handleLibraries(mux, c)
	// For `gateway status` on this machine. Loopback only, even with a page
	// cookie: it's a machine-local API, not part of the LAN page.
	mux.HandleFunc("GET /status.json", func(w http.ResponseWriter, r *http.Request) {
		if ip, _, err := net.SplitHostPort(r.RemoteAddr); err != nil || !net.ParseIP(ip).IsLoopback() {
			http.Error(w, "loopback only", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		logErr(json.NewEncoder(w).Encode(Status{
			Name: c.Name(), Version: c.Version, Update: *c.Update.Load(),
			LastBeat: c.LastBeat.Load(), Jellyfin: c.Jellyfin(),
		}))
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

// handleLibraries adds the /libraries page and its posts (only with c.Libraries).
func handleLibraries(mux *http.ServeMux, c Config) {
	// Not on the main page: reading libraries signs in as Jellyfin's admin,
	// which the main page's 3 s refresh would do every 3 s.
	showLibs := func(w http.ResponseWriter, r *http.Request, failed error) {
		list, err := c.Libraries(r.Context())
		if failed != nil {
			err = failed
		}
		msg := ""
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			msg = "Jellyfin: " + err.Error()
		}
		logErr(libs.Execute(w, map[string]any{"Libraries": list, "Err": msg}))
	}
	libsDo := func(do func(r *http.Request) error) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if c.Libraries == nil {
				http.NotFound(w, r)
				return
			}
			if err := do(r); err != nil {
				showLibs(w, r, err)
				return
			}
			http.Redirect(w, r, "/libraries", http.StatusSeeOther)
		}
	}
	mux.HandleFunc("GET /libraries", func(w http.ResponseWriter, r *http.Request) {
		if c.Libraries == nil {
			http.NotFound(w, r)
			return
		}
		showLibs(w, r, nil)
	})
	mux.HandleFunc("POST /libraries/offline", libsDo(func(r *http.Request) error {
		return c.MakeOffline(r.Context(), r.FormValue("id"))
	}))
	mux.HandleFunc("POST /libraries/extras", libsDo(func(r *http.Request) error {
		return c.SetExtras(r.Context(), r.FormValue("id"), r.FormValue("on") == "1")
	}))
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
			Reachable, HasKey, NeedsLogin bool
			Version, Err                  string
		}
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf(
			"port %s: HTTP %d (another program, or an older gateway: run `gateway update`)",
			port,
			res.StatusCode,
		)
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
	fmt.Fprintf(
		w,
		"gateway    %s, version %s\nupdate     %s\nStreamIQ   %s\nJellyfin   %s\nlocal page http://localhost:%s\n",
		s.Name,
		s.Version,
		upd,
		beat,
		jf,
		port,
	)
	if pageLink != "" {
		fmt.Fprintf(w, "           from another device: %s\n", pageLink)
	}
	return nil
}

func offline(c Config) string {
	if c.Offline == nil {
		return ""
	}
	return c.Offline()
}

// logErr logs a response the page failed to write: the status is sent by then,
// so the client can't be told.
func logErr(err error) {
	if err != nil {
		log.Printf("gateway: local page: %v", err)
	}
}
