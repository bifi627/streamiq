package tunnel

// The gateway API (docs/protocol.md, "Gateway API"): /streamiq/* is answered by
// the gateway itself, never Jellyfin, through plain net/http handlers on a
// Router. Each feature package owns its handlers; cmd/gateway registers them.

import (
	"encoding/json"
	"fmt"
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
// with a method it isn't registered for 405 + Allow (#436).
type Router struct {
	mux     *http.ServeMux
	methods []string // every method a pattern names, for Allow
}

// NewRouter has the gateway-native endpoints (burst, screens) registered.
func NewRouter() *Router {
	r := &Router{mux: http.NewServeMux()}
	r.Handle("GET "+BurstPath, http.HandlerFunc(serveBurst))
	r.Handle("GET "+RoutePath, http.HandlerFunc(serveRoute))
	r.Handle("GET "+ScreenPath, http.HandlerFunc(serveScreen))
	r.Handle("POST "+ScreenPath+"/state", http.HandlerFunc(serveScreenState))
	r.Handle("GET "+ScreensPath, http.HandlerFunc(serveScreens))
	r.Handle("POST "+ScreensPath+"/{id}", http.HandlerFunc(serveScreenCommand))
	return r
}

// builtin serves a Root without its own Router (tests): the native endpoints only.
var builtin = NewRouter()

// Option wraps a route's handler at registration.
type Option func(http.Handler) http.Handler

// AdminOnly: only a household admin may call the route; a member (or a session
// without a role) gets 403. #89 decides per endpoint.
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
// never 502, which the web app shows as "media server down", #327; the
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
func Do(api *Router, who Session, method, url, body string) (status int, hdr map[string]string, reply string, after func()) {
	raw, _ := json.Marshal(tunnelReq{Method: method, URL: url, Body: body})
	st := &reqState{who: who}
	rec := httptest.NewRecorder()
	serve(rec, &Root{API: api, Jellyfin: &Jellyfin{}}, raw, st)
	res := rec.Result()
	return res.StatusCode, firstValues(res.Header), rec.Body.String(), st.run
}
