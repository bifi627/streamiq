package tunnel

// The gateway API (docs/protocol.md, "Gateway API"): /streamiq/* is answered by
// the gateway itself, never Jellyfin, through plain net/http handlers on a
// Router. Each feature package owns its handlers; cmd/gateway registers them.

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path"
	"slices"
	"strconv"
	"strings"
	"sync"
)

// Router is the gateway API: a stdlib ServeMux (Go 1.22 patterns, e.g.
// "POST /streamiq/screens/{id}"). An unknown path is 404, a known one called
// with a method it isn't registered for 405 + Allow.
type Router struct {
	mux     *http.ServeMux
	methods []string // every method a pattern names, for Allow
}

// NewRouter has the tunnel's own endpoints (burst, route) registered.
func NewRouter() *Router {
	r := &Router{mux: http.NewServeMux()}
	r.Handle("GET "+BurstPath, http.HandlerFunc(serveBurst))
	r.Handle("GET "+RoutePath, http.HandlerFunc(serveRoute))
	return r
}

// builtin serves a Root without its own Router (tests): the native endpoints only.
var builtin = NewRouter()

// Option wraps a route's handler at registration.
type Option func(http.Handler) http.Handler

// AdminOnly: only a household admin may call the route; a member (or a session
// without a role) gets 403.
func AdminOnly(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if SessionOf(r).Role != Admin {
			Fail(w, http.StatusForbidden, fmt.Errorf("gateway API: %s %s is admin-only", r.Method, r.URL.Path))
			return
		}
		h.ServeHTTP(w, r)
	})
}

// Handle registers h for pattern, wrapped by opts (the first one outermost).
func (rt *Router) Handle(pattern string, h http.Handler, opts ...Option) {
	for i := len(opts) - 1; i >= 0; i-- {
		h = opts[i](h)
	}
	rt.mux.Handle(pattern, h)
	if m, _, ok := strings.Cut(pattern, " "); ok && !slices.Contains(rt.methods, m) {
		rt.methods = append(rt.methods, m)
	}
}

// ServeHTTP routes r: an unknown path is 404, a known path with a wrong method 405.
func (rt *Router) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Only an exact, unencoded path is routed: an unclean one would get the mux's redirect.
	if r.URL.RawPath != "" || r.URL.Path != path.Clean(r.URL.Path) {
		Fail(w, http.StatusNotFound, fmt.Errorf("gateway API: no %s %s", r.Method, r.URL.Path))
		return
	}
	// HEAD is never served: the mux's GET would route it, but the tunnel writer doesn't drop bodies.
	if _, pattern := rt.mux.Handler(r); pattern != "" && r.Method != http.MethodHead {
		rt.mux.ServeHTTP(w, r)
		return
	}
	var allow []string // the methods the mux routes this path for (a {id} pattern needs matching, not a lookup)
	for _, m := range rt.methods {
		if _, pattern := rt.mux.Handler(&http.Request{Method: m, URL: r.URL, Host: r.Host}); pattern != "" {
			allow = append(allow, m)
		}
	}
	if len(allow) == 0 {
		Fail(w, http.StatusNotFound, fmt.Errorf("gateway API: no %s %s", r.Method, r.URL.Path))
		return
	}
	clear(w.Header())
	w.Header().Set("Allow", strings.Join(allow, ", "))
	refuse(w, http.StatusMethodNotAllowed, fmt.Errorf("gateway API: %s %s: allowed %v", r.Method, r.URL.Path, allow))
}

// Session is who sent a tunnel request: the broker session id, the client's
// pairing name (looked up only when a screen opens), and a channel closed when
// the request's data channel closes.
type Session struct {
	ID     string
	User   string // the user's users.id, from the broker's offer: picks their Jellyfin viewer
	Role   string // the user's role in this gateway's household, from the broker's offer: Admin | Member
	Key    string // the client key fp the session authed with (which device)
	Name   func() string
	Route  func() string // relay | lan | direct, decided at call time; nil outside a tunnel
	Closed <-chan struct{}
	Use    *Usage // what the tunnel's requests were for; nil records nothing
}

type callKey struct{}

// reqState is one gateway API request's tunnel state, in its context.
type reqState struct {
	who   Session
	mu    sync.Mutex
	after []func()
}

// SessionOf is the session that sent r (zero outside a tunnel request).
func SessionOf(r *http.Request) Session {
	if c, ok := r.Context().Value(callKey{}).(*reqState); ok {
		return c.who
	}
	return Session{}
}

// run runs the AfterReply hooks.
func (c *reqState) run() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, f := range c.after {
		f()
	}
}

// AfterReply runs f once the reply to r is delivered (the browser closed the
// channel, at worst EOFGrace after the reply ended): for work that would cut the
// reply off, like removing the calling client, which closes its own session.
func AfterReply(r *http.Request, f func()) {
	if c, ok := r.Context().Value(callKey{}).(*reqState); ok {
		c.mu.Lock()
		c.after = append(c.after, f)
		c.mu.Unlock()
	}
}

// Fail refuses a request: status (500 for a gateway API handler's own failure,
// never 502, which the web app shows as "media server down"; the
// Jellyfin proxy's 502 means just that) with no headers or body; err goes to
// the gateway log only.
func Fail(w http.ResponseWriter, status int, err error) {
	clear(w.Header())
	refuse(w, status, err)
}

// refuse is Fail keeping the headers already set (405's Allow).
func refuse(w http.ResponseWriter, status int, err error) {
	if fw, ok := w.(*frameWriter); ok && fw.status == 0 {
		fw.err = err // handleReq logs it
	} else {
		log.Printf("gateway: tunnel: %v", err)
	}
	w.WriteHeader(status)
}

// JSON answers status with v as a JSON body, not cached.
func JSON(w http.ResponseWriter, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		Fail(w, http.StatusInternalServerError, err)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Content-Length", strconv.Itoa(len(b)))
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(b) // the status is sent: a failed write only means the client left
}

// Do runs one gateway API request on api the way the tunnel does, minus WebRTC,
// and reads the whole reply: for handler tests in the packages that own them.
// after runs the handler's AfterReply hooks.
func Do(
	api *Router,
	who Session,
	method, url, body string,
) (status int, hdr map[string]string, reply string, after func()) {
	raw, _ := json.Marshal(tunnelReq{Method: method, URL: url, Body: body})
	st := &reqState{who: who}
	rec := httptest.NewRecorder()
	serve(rec, &Root{API: api, Jellyfin: &Jellyfin{}}, raw, st)
	res := rec.Result()
	return res.StatusCode, firstValues(res.Header), rec.Body.String(), st.run
}

// Open is Do for a held reply (a screen's stream): it returns once the head is
// set, and the body streams from the reader (closing it ends the handler's next
// Write; who.Closed is what ends its context).
func Open(api *Router, who Session, method, url, body string) (status int, reply io.ReadCloser) {
	raw, _ := json.Marshal(tunnelReq{Method: method, URL: url, Body: body})
	status, _, reply = stream(&Root{API: api, Jellyfin: &Jellyfin{}}, raw, who)
	return status, reply
}

// stream serves the request frame raw the way handleReq does, returning once
// the head is set; the body streams from the reader.
func stream(rt *Root, raw []byte, who Session) (int, map[string]string, io.ReadCloser) {
	pr, pw := io.Pipe()
	w := &pipeWriter{hdr: http.Header{}, pw: pw, head: make(chan struct{})}
	go func() {
		defer func() {
			if p := recover(); p != nil {
				w.WriteHeader(http.StatusBadGateway)
				pw.CloseWithError(fmt.Errorf("aborted: %v", p))
				return
			}
			pw.Close()
		}()
		serve(w, rt, raw, &reqState{who: who})
	}()
	<-w.head
	return w.status, firstValues(w.hdr), pr
}

// pipeWriter streams a handler's reply into a pipe: the tunnel minus WebRTC.
type pipeWriter struct {
	hdr    http.Header
	pw     *io.PipeWriter
	head   chan struct{} // closed once status is set
	status int
}

func (w *pipeWriter) Header() http.Header { return w.hdr }
func (w *pipeWriter) Flush()              {}
func (w *pipeWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
		close(w.head)
	}
}
func (w *pipeWriter) Write(b []byte) (int, error) { w.WriteHeader(200); return w.pw.Write(b) }
