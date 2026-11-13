// Package tunnel is the HTTP-over-data-channel primitive (docs/protocol.md,
// "Tunnel framing"): one data channel per request, response head as a text
// frame, body as ~16KB binary chunks under bufferedAmount backpressure, then an
// `{"eof":true}` text frame; the browser closes the channel. Media bytes pass through untouched (never recompressed); the
// Jellyfin policy (jellyfin.go) decides what may pass and redacts the token.
package tunnel

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	ChunkSize   = 16 * 1024 // ponytail: 16KB chunks per the data-channel rule
	MaxBuffered = 1 << 20   // 1MB send-buffer high-water mark (backpressure)
	// EOFGrace: how long the gateway waits for the browser to close after EOF.
	// Backstop for a browser that never does (old client, dead tab).
	EOFGrace = 10 * time.Second
)

// Gate returns a wait() to call before each Send. It blocks until the channel's
// SCTP send buffer has drained below the low-water mark, so the producer can't
// queue gigabytes ahead of the ~tens-of-MB/s drain (the 20GB-RAM incident).
func Gate(d *webrtc.DataChannel) func() {
	drained := make(chan struct{}, 1)
	d.SetBufferedAmountLowThreshold(MaxBuffered / 2)
	d.OnBufferedAmountLow(func() {
		select {
		case drained <- struct{}{}:
		default:
		}
	})
	return func() {
		if d.BufferedAmount() > MaxBuffered {
			<-drained
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

// Serve treats the channel's first message as an HTTP request, proxies it
// to Jellyfin, and streams the response back. One channel == one request/response.
func Serve(d *webrtc.DataChannel, j *Jellyfin, who Session) {
	var once sync.Once
	closed := make(chan struct{})
	var closeOnce sync.Once
	d.OnClose(func() { closeOnce.Do(func() { close(closed) }) })
	who.Closed = closed
	d.OnMessage(func(m webrtc.DataChannelMessage) {
		once.Do(func() { go handleReq(d, j, m.Data, who) })
	})
}

// handleReq ends with an explicit EOF frame and lets the browser close the
// channel: closing right after the last frame loses it on old Chromium (Chrome
// 87 on webOS drops frames still in flight on a remote close, #71/#72).
func handleReq(d *webrtc.DataChannel, j *Jellyfin, raw []byte, who Session) {
	defer func() {
		if err := d.SendText(`{"eof":true}`); err == nil {
			select {
			case <-who.Closed:
			case <-time.After(EOFGrace):
			}
		}
		d.Close()
	}()

	status, hdr, body, err := proxy(j, raw, who)
	if err != nil {
		log.Printf("gateway: tunnel: %v", err)
		if status == 0 {
			status = http.StatusBadGateway
		}
		sendHead(d, status, nil)
		return
	}
	defer body.Close()

	sendHead(d, status, hdr)
	streamBody(d, body)
	log.Printf("gateway: tunnel -> %d", status)
}

// proxy is the tunnel's pure core: decode the request frame, apply the
// Jellyfin policy, call Jellyfin forwarding headers (Range included, so seek
// survives), and hand back the response status/headers/body for the caller to
// stream. No WebRTC here, so it is unit-tested directly (tunnel_test.go). On
// error, a non-zero status is the refusal to send (e.g. 403, 413, 503).
func proxy(j *Jellyfin, raw []byte, who Session) (int, map[string]string, io.ReadCloser, error) {
	var rq tunnelReq
	if err := json.Unmarshal(raw, &rq); err != nil {
		return http.StatusBadRequest, nil, nil, fmt.Errorf("bad request frame: %w", err)
	}
	if len(rq.Body) > MaxBody {
		return http.StatusRequestEntityTooLarge, nil, nil, fmt.Errorf("body %d bytes", len(rq.Body))
	}
	if u, err := url.Parse(rq.URL); err == nil && isGatewayAPI(u.Path) {
		return gatewayAPI(j, rq, u, who)
	}
	c := j.credFor(who.User)
	req, status, err := j.prepare(rq, c)
	if err != nil {
		return status, nil, nil, err
	}
	resp, err := j.Client.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	hdr := make(map[string]string, len(resp.Header)+1)
	for k := range resp.Header {
		hdr[k] = resp.Header.Get(k) // ponytail: last value wins; Jellyfin sends no dup headers that matter
	}
	// Go's Transport promotes Content-Length out of Header into resp.ContentLength;
	// re-add it so the browser (and hls.js) knows the body size. -1 = unknown.
	if resp.ContentLength >= 0 {
		hdr["Content-Length"] = strconv.FormatInt(resp.ContentLength, 10)
	}
	body, err := redact(hdr, resp.Body, c.key)
	if err != nil {
		resp.Body.Close()
		return 0, nil, nil, err
	}
	return resp.StatusCode, hdr, body, nil
}

// gatewayAPI answers /streamiq/* (docs/protocol.md, "Gateway API"): the gateway
// itself, never Jellyfin, and without a Jellyfin token. Only an exact, unencoded
// path matches (GET, or POST on the screen endpoints); anything else under the
// prefix is 404.
func gatewayAPI(j *Jellyfin, rq tunnelReq, u *url.URL, who Session) (int, map[string]string, io.ReadCloser, error) {
	method := rq.Method
	switch {
	case u.RawPath != "":
	case AdminOnly[u.Path] && who.Role != Admin:
		return http.StatusForbidden, nil, nil, fmt.Errorf("gateway API: %s %s is admin-only", method, u.Path)
	case isScreenPath(u.Path):
		return screenAPI(method, u.Path, rq.Body, who)
	case method != "GET":
	case u.Path == BurstPath:
		return burst(u.Query().Get("size"))
	case u.Path == StatusPath && j.Status != nil:
		b, err := json.Marshal(j.Status())
		if err != nil {
			return 0, nil, nil, err
		}
		hdr := map[string]string{"Content-Type": "application/json", "Content-Length": strconv.Itoa(len(b)), "Cache-Control": "no-store"}
		return http.StatusOK, hdr, io.NopCloser(bytes.NewReader(b)), nil
	}
	return http.StatusNotFound, nil, nil, fmt.Errorf("gateway API: no %s %s", method, u.Path)
}

// Roles in the broker's offer (docs/protocol.md, "Device + user").
const (
	Admin  = "admin"
	Member = "member"
)

// AdminOnly marks gateway API paths (exact, any method) that only a household
// admin may call; a member gets 403. None yet: #89 decides per endpoint.
// ponytail: exact paths only; a prefix/pattern match when an admin-only path takes an id.
var AdminOnly = map[string]bool{}

// isGatewayAPI: the prefix is matched case-insensitively, like Jellyfin's
// routing, so no spelling of it reaches Jellyfin.
func isGatewayAPI(p string) bool {
	p = strings.ToLower(p)
	return p == "/streamiq" || strings.HasPrefix(p, "/streamiq/")
}

// StatusPath is the gateway's status for the web gateway page (#146; #140 adds fields).
const StatusPath = "/streamiq/status"

// BurstPath is the throughput test (#90): the gateway answers it itself with
// generated bytes, never Jellyfin. Only reachable on an authed tunnel (Serve
// runs after auth), and size-capped so a client can't make it stream forever.
const (
	BurstPath    = "/streamiq/burst"
	BurstDefault = 4 << 20
	BurstMax     = 16 << 20
)

func burst(size string) (int, map[string]string, io.ReadCloser, error) {
	n := int64(BurstDefault)
	if size != "" {
		v, err := strconv.ParseInt(size, 10, 64)
		if err != nil || v < 0 || v > BurstMax {
			return http.StatusBadRequest, nil, nil, fmt.Errorf("burst size %q (0..%d)", size, BurstMax)
		}
		n = v
	}
	hdr := map[string]string{
		"Content-Type":   "application/octet-stream",
		"Content-Length": strconv.FormatInt(n, 10),
		"Cache-Control":  "no-store",
	}
	return http.StatusOK, hdr, io.NopCloser(bytes.NewReader(make([]byte, n))), nil // ponytail: zeros; the tunnel never compresses
}

func sendHead(d *webrtc.DataChannel, status int, headers map[string]string) {
	b, _ := json.Marshal(map[string]any{"status": status, "headers": headers})
	if err := d.SendText(string(b)); err != nil {
		log.Printf("gateway: send head: %v", err)
	}
}

// streamBody relays the response body as backpressured binary chunks. The head
// frame is text; body frames are binary — the browser tells them apart by type.
func streamBody(d *webrtc.DataChannel, body io.Reader) {
	buf := make([]byte, ChunkSize)
	wait := Gate(d)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			wait()
			if e := d.Send(buf[:n]); e != nil {
				log.Printf("gateway: tunnel send body: %v", e)
				return
			}
		}
		if err != nil {
			return // io.EOF (or read error) → caller sends the EOF frame
		}
	}
}
