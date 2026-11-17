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
	"strconv"
	"sync"
)

// Router is the gateway API: a stdlib ServeMux (Go 1.22 patterns, e.g.
// "POST /streamiq/screens/{id}") that answers 404 for anything it doesn't
// route (an unknown path or a wrong method; #436 makes the latter 405).
type Router struct{ mux *http.ServeMux }

// NewRouter has the gateway-native endpoints (burst, screens) registered.
func NewRouter() *Router {
	r := &Router{http.NewServeMux()}
	r.Handle("GET "+BurstPath, http.HandlerFunc(serveBurst))
	r.Handle("GET "+ScreenPath, http.HandlerFunc(serveScreen))
	r.Handle("POST "+ScreenPath+"/state", http.HandlerFunc(serveScreenState))
	r.Handle("GET "+ScreensPath, http.HandlerFunc(serveScreens))
	r.Handle("POST "+ScreensPath+"/{id}", http.HandlerFunc(serveScreenCommand))
	return r
}

// builtin serves a Jellyfin without its own Router (tests): the native endpoints only.
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
}

// ServeHTTP routes r; whatever the mux doesn't route is 404.
func (rt *Router) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Only an exact, unencoded path is routed: an unclean one would get the mux's redirect.
	// ponytail: the mux's GET also routes HEAD, which was always 404 here; #436 decides.
	if _, pattern := rt.mux.Handler(r); pattern == "" || r.Method == http.MethodHead ||
		r.URL.RawPath != "" || r.URL.Path != path.Clean(r.URL.Path) {
		Fail(w, http.StatusNotFound, fmt.Errorf("gateway API: no %s %s", r.Method, r.URL.Path))
		return
	}
	rt.mux.ServeHTTP(w, r)
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
	if fw, ok := w.(*frameWriter); ok && fw.status == 0 {
		fw.err = err // handleReq logs it
	} else {
		log.Printf("gateway: tunnel: %v", err)
	}
	clear(w.Header())
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
	w.Write(b)
}

// Do runs one gateway API request on api the way the tunnel does, minus WebRTC,
// and reads the whole reply: for handler tests in the packages that own them.
// after runs the handler's AfterReply hooks.
func Do(api *Router, who Session, method, url, body string) (status int, hdr map[string]string, reply string, after func()) {
	raw, _ := json.Marshal(tunnelReq{Method: method, URL: url, Body: body})
	st := &reqState{who: who}
	rec := httptest.NewRecorder()
	serve(rec, &Jellyfin{API: api}, raw, st)
	res := rec.Result()
	return res.StatusCode, firstValues(res.Header), rec.Body.String(), st.run
}
