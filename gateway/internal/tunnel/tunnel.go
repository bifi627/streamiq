// Package tunnel is the HTTP-over-data-channel primitive (docs/protocol.md,
// "Tunnel framing"): one data channel per request, response head as a text
// frame, body as ~16KB binary chunks under bufferedAmount backpressure, channel
// close = EOF. Media bytes pass through untouched (never recompressed); the
// Jellyfin policy (jellyfin.go) decides what may pass and redacts the token.
package tunnel

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"sync"

	"github.com/pion/webrtc/v4"
)

const (
	ChunkSize   = 16 * 1024 // ponytail: 16KB chunks per the data-channel rule
	MaxBuffered = 1 << 20   // 1MB send-buffer high-water mark (backpressure)
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
// to Jellyfin, and streams the response back. One channel == one request/response;
// closing the channel is the body's EOF marker for the browser.
func Serve(d *webrtc.DataChannel, j *Jellyfin) {
	var once sync.Once
	d.OnMessage(func(m webrtc.DataChannelMessage) {
		once.Do(func() { go handleReq(d, j, m.Data) })
	})
}

func handleReq(d *webrtc.DataChannel, j *Jellyfin, raw []byte) {
	defer d.Close()

	status, hdr, body, err := proxy(j, raw)
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
// error, a non-zero status is the refusal to send (403, 413, 503).
func proxy(j *Jellyfin, raw []byte) (int, map[string]string, io.ReadCloser, error) {
	var rq tunnelReq
	if err := json.Unmarshal(raw, &rq); err != nil {
		return http.StatusBadRequest, nil, nil, fmt.Errorf("bad request frame: %w", err)
	}
	req, status, err := j.prepare(rq)
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
	body, err := j.redact(hdr, resp.Body)
	if err != nil {
		resp.Body.Close()
		return 0, nil, nil, err
	}
	return resp.StatusCode, hdr, body, nil
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
			return // io.EOF (or read error) → defer closes the channel = EOF
		}
	}
}
