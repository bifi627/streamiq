package tunnel

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
)

// Jellyfin is the tunnel's only origin, plus the policy that keeps a paired
// browser a *viewer* (docs/protocol.md, "Jellyfin policy"):
//   - the browser never holds a Jellyfin credential: the gateway injects its
//     token and strips any the browser sends; response text that echoes the
//     token (Jellyfin writes ApiKey= into subtitle playlist URLs) is redacted;
//   - the token belongs to a non-admin viewer user (internal/jellyfin), and an
//     allowlist of consumption endpoints still applies (defense in depth);
//   - every request is pinned to the token's Jellyfin user (userId);
//   - the token is the session user's own viewer's (#195), else the shared one.
type Jellyfin struct {
	Client *http.Client
	URL    string // e.g. http://localhost:8096
	// Viewer is a StreamIQ user's own token and Jellyfin user id; "" = none, use
	// the shared one (SetKey). nil = everyone shares it.
	Viewer func(user string) (key, userID string)

	cred atomic.Pointer[cred] // SetKey; may arrive after start (internal/jellyfin)
}

type cred struct{ key, userID string }

// SetKey installs the token and the Jellyfin user id it belongs to. Safe
// while sessions run.
func (j *Jellyfin) SetKey(key, userID string) { j.cred.Store(&cred{key, userID}) }

// credFor is the credential a request of user's session uses.
func (j *Jellyfin) credFor(user string) cred {
	if j.Viewer != nil && user != "" {
		if k, id := j.Viewer(user); k != "" && id != "" {
			return cred{k, id}
		}
	}
	return j.current()
}

func (j *Jellyfin) current() cred {
	if c := j.cred.Load(); c != nil {
		return *c
	}
	return cred{}
}

const (
	id      = `[0-9a-fA-F-]{32,36}`
	MaxBody = 64 * 1024        // request bodies: small JSON only
	maxText = 16 * 1024 * 1024 // buffered (redacted) text responses
)

// allowed is the attack surface: add an endpoint here consciously. A refused
// request is a 403 + a gateway log line.
var allowed = []struct {
	method string
	re     *regexp.Regexp
}{
	{"GET", regexp.MustCompile(`^/System/Info/Public$`)},
	{"GET", regexp.MustCompile(`^/UserViews$`)},
	{"GET", regexp.MustCompile(`^/Items$`)},
	{"GET", regexp.MustCompile(`^/UserItems/Resume$`)},
	{"GET", regexp.MustCompile(`^/Items/` + id + `$`)},
	{"GET", regexp.MustCompile(`^/Shows/` + id + `/(Seasons|Episodes)$`)},
	{"GET", regexp.MustCompile(`^/Items/` + id + `/Images/[A-Za-z]+(/[0-9]+)?$`)},
	{"POST", regexp.MustCompile(`^/Items/` + id + `/PlaybackInfo$`)},
	{"POST", regexp.MustCompile(`^/UserItems/` + id + `/UserData$`)}, // resume position / played
	// Every GET under /Videos/{id}/ is a read: HLS playlists + segments, subtitles.
	// Case-insensitive like Jellyfin's routing: PlaybackInfo's TranscodingUrl
	// says /videos/.
	{"GET", regexp.MustCompile(`(?i)^/Videos/` + id + `/[A-Za-z0-9._/-]+$`)},
}

// allow reports whether method+path is on the allowlist. path must already be
// clean: the caller rejects "..", "//" and percent-encoded paths.
func allow(method, p string) bool {
	for _, a := range allowed {
		if a.method == method && a.re.MatchString(p) {
			return true
		}
	}
	return false
}

// ServeHTTP is the Jellyfin proxy: it applies the Jellyfin policy, calls
// Jellyfin forwarding headers (Range included, so seek survives) and copies its
// response into w, redacted.
func (j *Jellyfin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c := j.credFor(SessionOf(r).User)
	req, status, err := j.prepare(r, c)
	if err != nil {
		Fail(w, status, err)
		return
	}
	resp, err := j.Client.Do(req)
	if err != nil {
		Fail(w, http.StatusBadGateway, err)
		return
	}
	defer resp.Body.Close()
	hdr := w.Header()
	for k := range resp.Header {
		hdr.Set(k, resp.Header.Get(k))
	}
	// Go's Transport promotes Content-Length out of Header into resp.ContentLength;
	// re-add it so the browser (and hls.js) knows the body size. -1 = unknown.
	if resp.ContentLength >= 0 {
		hdr.Set("Content-Length", strconv.FormatInt(resp.ContentLength, 10))
	}
	body, err := redact(hdr, resp.Body, c.key)
	if err != nil {
		Fail(w, http.StatusBadGateway, err)
		return
	}
	w.WriteHeader(resp.StatusCode)
	// ChunkSize reads: one frame each, as before (#258).
	if _, err := io.CopyBuffer(w, body, make([]byte, ChunkSize)); err != nil && !errors.Is(err, errClosed) {
		log.Printf("gateway: tunnel: %v", err)
		panic(http.ErrAbortHandler) // handleReq: the body was cut off
	}
}

// prepare turns a browser request into the origin request, or returns the
// HTTP status to refuse it with. It reads the frame's URL as sent (RequestURI).
func (j *Jellyfin) prepare(r *http.Request, c cred) (*http.Request, int, error) {
	if c.key == "" || c.userID == "" {
		return nil, http.StatusServiceUnavailable, fmt.Errorf("no Jellyfin token yet (see the gateway's local page)")
	}
	u, err := url.Parse(r.RequestURI)
	if err != nil || u.IsAbs() || u.Host != "" || u.User != nil || u.RawPath != "" || u.Path != path.Clean(u.Path) ||
		!allow(r.Method, u.Path) {
		return nil, http.StatusForbidden, fmt.Errorf("refused %s %s", r.Method, r.RequestURI)
	}
	q := u.Query()
	for k := range q {
		switch strings.ToLower(k) {
		case "api_key", "apikey", "userid":
			q.Del(k)
		}
	}
	q.Set("userId", c.userID)
	u.RawQuery = q.Encode()

	var body io.Reader
	b := readBody(r)
	if len(b) > 0 {
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequest(r.Method, j.URL+u.String(), body)
	if err != nil {
		return nil, http.StatusBadRequest, err
	}
	for k, vs := range r.Header {
		v := vs[0]
		switch lk := strings.ToLower(k); {
		case lk == "authorization", lk == "cookie", strings.HasPrefix(lk, "x-emby"),
			strings.HasPrefix(lk, "x-mediabrowser"):
			// the browser's credentials (if any) never reach Jellyfin
		case lk == "accept-encoding":
			// Go's Transport then negotiates gzip itself and decompresses, so redact
			// sees plain text; a browser-chosen encoding would hide the key from it
		default:
			req.Header.Set(k, v)
		}
	}
	if len(b) > 0 && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", `MediaBrowser Token="`+c.key+`"`)
	return req, 0, nil
}

// redact buffers text responses (JSON, playlists) and removes the token key.
// Media (video/*, image/*) streams through untouched.
func redact(hdr http.Header, body io.ReadCloser, key string) (io.ReadCloser, error) {
	ct := strings.ToLower(hdr.Get("Content-Type"))
	if !strings.Contains(ct, "json") && !strings.Contains(ct, "mpegurl") && !strings.HasPrefix(ct, "text/") {
		return body, nil
	}
	defer body.Close()
	b, err := io.ReadAll(io.LimitReader(body, maxText+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxText {
		return nil, fmt.Errorf("text response over %d bytes", maxText)
	}
	if key != "" {
		b = bytes.ReplaceAll(b, []byte(key), []byte("redacted"))
	}
	hdr.Set("Content-Length", fmt.Sprint(len(b)))
	return io.NopCloser(bytes.NewReader(b)), nil
}
