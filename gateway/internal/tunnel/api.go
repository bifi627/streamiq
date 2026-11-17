package tunnel

// The gateway API (docs/protocol.md, "Gateway API"): /streamiq/* is answered by
// the gateway itself, never Jellyfin, through plain net/http handlers on a
// Router. Each feature package owns its handlers; cmd/gateway registers them.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
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

// ServeHTTP routes r; whatever the mux doesn't route is 404. The path must be
// clean: an unclean one would get the mux's redirect.
func (rt *Router) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// ponytail: the mux's GET also routes HEAD, which was always 404 here; #436 decides.
	if _, pattern := rt.mux.Handler(r); pattern == "" || r.Method == http.MethodHead {
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

// Fail refuses a request: status (500 for the handler's own failure, never
// 502, which the web app shows as "media server down", #327) with no headers or
// body; err goes to the gateway log only.
func Fail(w http.ResponseWriter, status int, err error) {
	if rw, ok := w.(*replyWriter); ok && rw.status == 0 {
		rw.err = err // handleReq logs it
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
	w.Write(b)
}

// replyWriter adapts a handler to handleReq: the status and headers become the
// head frame once the handler writes (or returns), the body is a pipe that
// streamBody relays in ChunkSize frames under backpressure (Gate). The pipe
// has no buffer, so every Write is already flushed.
type replyWriter struct {
	hdr    http.Header
	pw     *io.PipeWriter
	head   chan struct{} // closed once status is set
	status int
	sent   map[string]string // hdr as the head frame carries it
	err    error             // from Fail
}

func (w *replyWriter) Header() http.Header { return w.hdr }

func (w *replyWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	for k, v := range w.hdr {
		if len(v) == 0 {
			continue
		}
		if w.sent == nil {
			w.sent = map[string]string{}
		}
		w.sent[k] = v[0]
	}
	w.status = status
	close(w.head)
}

func (w *replyWriter) Write(b []byte) (int, error) {
	w.WriteHeader(http.StatusOK)
	return w.pw.Write(b)
}

func (w *replyWriter) Flush() {}

// gatewayAPI runs the request frame rq on api. Only an exact, unencoded path is
// routed; anything else under the prefix is 404.
func gatewayAPI(api *Router, rq tunnelReq, u *url.URL, who Session) (int, map[string]string, io.ReadCloser, error) {
	if u.RawPath != "" || u.Path != path.Clean(u.Path) {
		return http.StatusNotFound, nil, nil, fmt.Errorf("gateway API: no %s %s", rq.Method, u.Path)
	}
	c := &reqState{who: who}
	// r.Context() ends when the channel closes, the reply body is closed (the
	// reply can't be sent on), or the handler returns.
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), callKey{}, c))
	if who.Closed != nil {
		go func() {
			select {
			case <-who.Closed:
				cancel()
			case <-ctx.Done():
			}
		}()
	}
	r := (&http.Request{
		Method: rq.Method, URL: u, RequestURI: rq.URL, Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
		Header: http.Header{}, Body: io.NopCloser(strings.NewReader(rq.Body)), ContentLength: int64(len(rq.Body)),
	}).WithContext(ctx)
	for k, v := range rq.Headers {
		r.Header.Set(k, v)
	}
	pr, pw := io.Pipe()
	w := &replyWriter{hdr: http.Header{}, pw: pw, head: make(chan struct{})}
	go func() {
		defer cancel()
		defer pw.Close()
		defer w.WriteHeader(http.StatusOK) // a handler that wrote nothing: 200, empty
		api.ServeHTTP(w, r)
	}()
	<-w.head
	if w.err != nil {
		cancel()
		pr.Close()
		return w.status, nil, nil, w.err
	}
	return w.status, w.sent, afterReply{replyBody{pr, cancel}, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		for _, f := range c.after {
			f()
		}
	}}, nil
}

// afterReply is a response body whose after runs once the reply is delivered
// (handleReq, after the channel closes).
type afterReply struct {
	io.ReadCloser
	after func()
}

// replyBody is the reply's read end; closing it ends the handler's context.
type replyBody struct {
	*io.PipeReader
	cancel func()
}

func (b replyBody) Close() error { b.cancel(); return b.PipeReader.Close() }

// Do runs one gateway API request on api the way the tunnel does, minus WebRTC,
// and reads the whole reply: for handler tests in the packages that own them.
// after runs the handler's AfterReply hooks.
func Do(api *Router, who Session, method, url, body string) (status int, hdr map[string]string, reply string, after func()) {
	raw, _ := json.Marshal(tunnelReq{Method: method, URL: url, Body: body})
	status, hdr, rc, _ := proxy(&Jellyfin{API: api}, raw, who)
	after = func() {}
	if rc != nil {
		if a, ok := rc.(afterReply); ok {
			after = a.after
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		reply = string(b)
	}
	return status, hdr, reply, after
}
