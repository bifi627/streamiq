// Package tunnel is the HTTP-over-data-channel primitive (docs/protocol.md,
// "Tunnel framing"): one data channel per request, response head as a text
// frame, body as ~60KB binary chunks under bufferedAmount backpressure, then an
// `{"eof":true}` text frame (`{"error":…}` if the body broke off); the browser closes the channel. Media bytes pass through untouched (never recompressed); the
// Jellyfin policy (jellyfin.go) decides what may pass and redacts the token.
package tunnel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	ChunkSize   = 60 * 1024 // ~4× fewer messages than 16KB (per-message cost caps a slow client); under Pion's 65535 limit for a peer without max-message-size
	MaxBuffered = 1 << 20   // 1MB send-buffer high-water mark (backpressure)
	// EOFGrace: how long the gateway waits for the browser to close after EOF.
	// Backstop for a browser that never does (old client, dead tab).
	EOFGrace = 10 * time.Second
	// MaxChannels: tunnel channels served at once on one PeerConnection; one over
	// it is closed unread. The web client peaks near 15 (4 posters, hls.js video +
	// audio + subtitle + playlist loads plus ones a seek aborted, the held screen
	// response, a burst, a few JSON calls). Worst case per connection: 32 × 16 MB
	// (maxText) of buffered text, a few times that while it is read and redacted,
	// plus 32 × ~1 MB (MaxBuffered) of send buffer.
	MaxChannels = 32
)

// Gate returns a wait() to call before each Send. It blocks until the channel's
// SCTP send buffer has drained below the low-water mark, so the producer can't
// queue gigabytes ahead of the ~tens-of-MB/s drain (the 20GB-RAM incident).
// Once closed is closed (the channel or its connection is gone) wait returns
// false, at once and from then on: the sender stops.
func Gate(d *webrtc.DataChannel, closed <-chan struct{}) func() bool {
	drained := make(chan struct{}, 1)
	d.SetBufferedAmountLowThreshold(MaxBuffered / 2)
	d.OnBufferedAmountLow(func() {
		select {
		case drained <- struct{}{}:
		default:
		}
	})
	return func() bool {
		if d.BufferedAmount() > MaxBuffered {
			select {
			case <-drained:
			case <-closed:
			}
		}
		select {
		case <-closed:
			return false
		default:
			return true
		}
	}
}

// tunnelReq is the browser→gateway request frame (docs/protocol.md).
type tunnelReq struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"` // origin-relative, e.g. "/Items?parentId=…"
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body,omitempty"` // small JSON (POST), ≤ MaxBody
}

// Root is the tunnel's root handler: the /streamiq prefix (any spelling, so
// none of it reaches Jellyfin) goes to the gateway API, the rest to Jellyfin.
type Root struct {
	// API answers /streamiq/* (api.go); nil = the gateway-native endpoints only.
	API      *Router
	Jellyfin *Jellyfin // the tunnel's only origin + its policy
}

func (rt *Root) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !isGatewayAPI(r.URL.Path) {
		rt.Jellyfin.ServeHTTP(w, r)
		return
	}
	api := rt.API
	if api == nil {
		api = builtin
	}
	api.ServeHTTP(w, r)
}

// Serve treats the channel's first message as an HTTP request, serves it on
// root (gateway API or Jellyfin), and streams the response back. One channel == one request/response.
// slots (cap MaxChannels, one per PeerConnection) counts the channels being
// served: a channel that finds it full is closed without reading a request; a
// served one gives its slot back when its request ends, or when the channel
// closes without one.
func Serve(d *webrtc.DataChannel, root *Root, who Session, slots chan struct{}) {
	select {
	case slots <- struct{}{}:
	default:
		log.Printf("gateway: tunnel: over %d channels on session %s, closed", cap(slots), who.ID)
		d.OnOpen(func() { d.Close() })
		return
	}
	free := sync.OnceFunc(func() { <-slots })
	var once sync.Once
	closed := make(chan struct{})
	var closeOnce sync.Once
	// A channel closed before its request: free here. With a request running, its
	// goroutine frees when it returns, so work that outlives the channel still counts.
	d.OnClose(func() { closeOnce.Do(func() { close(closed) }); once.Do(free) })
	who.Closed = closed
	d.OnMessage(func(m webrtc.DataChannelMessage) {
		once.Do(func() {
			go func() {
				defer free()
				handleReq(d, root, m.Data, who)
			}()
		})
	})
}

// handleReq serves one request frame on root with a ResponseWriter that sends
// the frames itself. It ends with an explicit EOF frame (or an error frame when the body broke off part-way) and
// lets the browser close the channel: closing right after the last frame loses
// it on old Chromium (Chrome 87 on webOS drops frames still in flight on a
// remote close; quirk(#72)).
func handleReq(d *webrtc.DataChannel, root *Root, raw []byte, who Session) {
	w := &frameWriter{d: d, hdr: http.Header{}, wait: Gate(d, who.Closed)}
	st := &reqState{who: who}
	defer func() {
		defer st.run() // AfterReply: once the browser has the reply and closed the channel
		end := `{"eof":true}`
		switch {
		case w.err != nil:
			log.Printf("gateway: tunnel: %v", w.err)
		case w.cut:
			log.Printf("gateway: tunnel -> %d, body cut off", w.status)
			end = `{"error":"body cut off"}` // ponytail: details stay in the log (they name LAN addresses)
		default:
			log.Printf("gateway: tunnel -> %d", w.status)
		}
		if err := d.SendText(end); err == nil {
			select {
			case <-who.Closed:
			case <-time.After(EOFGrace):
			}
		}
		d.Close()
	}()
	// A handler that gives up part-way panics with http.ErrAbortHandler, as under
	// net/http's server: the body is incomplete.
	defer func() {
		if p := recover(); p != nil {
			if p != http.ErrAbortHandler {
				panic(p)
			}
			w.cut = true
			w.WriteHeader(http.StatusBadGateway) // no-op once the head is out
		}
	}()
	serve(w, root, raw, st)
}

// serve decodes the request frame into an *http.Request (st in its context)
// and runs it on h; a frame it can't take is refused here. A handler that
// wrote nothing answers 200, empty.
func serve(w http.ResponseWriter, h http.Handler, raw []byte, st *reqState) {
	var rq tunnelReq
	if err := json.Unmarshal(raw, &rq); err != nil {
		Fail(w, http.StatusBadRequest, fmt.Errorf("bad request frame: %w", err))
		return
	}
	if len(rq.Body) > MaxBody {
		Fail(w, http.StatusRequestEntityTooLarge, fmt.Errorf("body %d bytes", len(rq.Body)))
		return
	}
	u, err := url.Parse(rq.URL)
	if err != nil {
		u = new(url.URL) // ponytail: Jellyfin's prepare re-parses RequestURI and refuses it (403)
	}
	defer func() { st.who.Use.record(rq.Method, u.Path, time.Now()) }()
	// r.Context() ends when the channel closes or the handler returns.
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), callKey{}, st))
	defer cancel()
	if st.who.Closed != nil {
		go func() {
			select {
			case <-st.who.Closed:
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
	h.ServeHTTP(w, r)
	w.WriteHeader(http.StatusOK)
}

// Roles in the broker's offer (docs/protocol.md, "Device + user").
const (
	Admin  = "admin"
	Member = "member"
)

// isGatewayAPI: the prefix is matched case-insensitively, like Jellyfin's
// routing, so no spelling of it reaches Jellyfin.
func isGatewayAPI(p string) bool {
	p = strings.ToLower(p)
	return p == "/streamiq" || strings.HasPrefix(p, "/streamiq/")
}

// StatusPath is the gateway's status for the web gateway page.
const StatusPath = "/streamiq/status"

// RoutePath is the privacy badge's route for the calling tunnel.
const RoutePath = "/streamiq/route"

func serveRoute(w http.ResponseWriter, r *http.Request) {
	rt := "direct" // ponytail: no Route = a test session, never a real tunnel
	if f := SessionOf(r).Route; f != nil {
		rt = f()
	}
	JSON(w, http.StatusOK, Route{rt})
}

// ThroughputPath keeps the throughput the browser measured on the calling tunnel, for
// its history line.
const ThroughputPath = "/streamiq/tunnels/throughput"

func serveThroughput(w http.ResponseWriter, r *http.Request) {
	var b Throughput
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&b) != nil {
		Fail(w, http.StatusBadRequest, errors.New("throughput: bad body"))
		return
	}
	SessionOf(r).Use.SetThroughput(b.ThroughputKbps)
	w.WriteHeader(http.StatusNoContent)
}

// PlaybackPath adds one playback's summary to the calling tunnel's history line.
const PlaybackPath = "/streamiq/tunnels/playback"

var playbackItem = regexp.MustCompile(`^` + JellyfinID + `$`)

func servePlayback(w http.ResponseWriter, r *http.Request) {
	var b Playback
	// The line is read back with a 64 KiB-per-line scanner: every entry stays small.
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&b) != nil ||
		!playbackItem.MatchString(b.ItemID) || len(b.Codec) > 32 || len(b.Quality) > 32 {
		Fail(w, http.StatusBadRequest, errors.New("playback: bad body"))
		return
	}
	SessionOf(r).Use.AddPlayback(b)
	w.WriteHeader(http.StatusNoContent)
}

// BurstPath is the throughput test: the gateway answers it itself with
// generated bytes, never Jellyfin. Only reachable on an authed tunnel (Serve
// runs after auth), and size-capped so a client can't make it stream forever.
const (
	BurstPath    = "/streamiq/burst"
	BurstDefault = 4 << 20
	BurstMax     = 16 << 20
)

func serveBurst(w http.ResponseWriter, r *http.Request) {
	n := int64(BurstDefault)
	if size := r.URL.Query().Get("size"); size != "" {
		v, err := strconv.ParseInt(size, 10, 64)
		if err != nil || v < 0 || v > BurstMax {
			Fail(w, http.StatusBadRequest, fmt.Errorf("burst size %q (0..%d)", size, BurstMax))
			return
		}
		n = v
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Length", strconv.FormatInt(n, 10))
	h.Set("Cache-Control", "no-store")
	// ponytail: zeros; the tunnel never compresses. ChunkSize writes: one frame each.
	// a failed copy means the client stopped the test: nothing to tell it
	_, _ = io.CopyBuffer(w, io.LimitReader(zeros{}, n), make([]byte, ChunkSize))
}

// zeros is an endless stream of zero bytes: the burst is generated a chunk at a
// time, never allocated whole.
type zeros struct{}

func (zeros) Read(p []byte) (int, error) { clear(p); return len(p), nil }

// errClosed: the channel (or its connection) is gone; nobody is left to send to.
var errClosed = errors.New("tunnel: channel closed")

// frameWriter is the tunnel's http.ResponseWriter: the status and headers go
// out as the head frame (text) on the first Write or WriteHeader, the body as
// binary frames of at most ChunkSize under backpressure (Gate) — the browser
// tells them apart by type. Every Write is sent before it returns, so Flush has
// nothing to do.
type frameWriter struct {
	d      *webrtc.DataChannel
	hdr    http.Header
	wait   func() bool
	status int
	err    error // from Fail: the refusal handleReq logs
	cut    bool  // the body broke off: a send failed or the handler aborted
}

func (w *frameWriter) Header() http.Header { return w.hdr }

func (w *frameWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
	b, _ := json.Marshal(map[string]any{"status": status, "headers": firstValues(w.hdr)})
	if err := w.d.SendText(string(b)); err != nil {
		log.Printf("gateway: send head: %v", err)
	}
}

func (w *frameWriter) Write(b []byte) (int, error) {
	w.WriteHeader(http.StatusOK)
	n := 0
	for len(b) > 0 {
		c := b[:min(len(b), ChunkSize)]
		if !w.wait() {
			return n, errClosed
		}
		if err := w.d.Send(c); err != nil {
			w.cut = true
			return n, fmt.Errorf("send body: %w", err)
		}
		n += len(c)
		b = b[len(c):]
	}
	return n, nil
}

func (w *frameWriter) Flush() {}

// firstValues is h as the head frame carries it: one value per header (nil if none).
func firstValues(h http.Header) map[string]string {
	var m map[string]string
	for k, v := range h {
		if len(v) == 0 {
			continue
		}
		if m == nil {
			m = map[string]string{}
		}
		m[k] = v[0] // ponytail: first value wins; Jellyfin sends no dup headers that matter
	}
	return m
}
