package tunnel

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"sync/atomic"
)

// Jellyfin is the tunnel's only origin, plus the policy that keeps a paired
// browser a *viewer* (docs/protocol.md, "Jellyfin policy"):
//   - the browser never holds a Jellyfin credential: the gateway injects its
//     token and strips any the browser sends; response text that echoes the
//     token (Jellyfin writes ApiKey= into subtitle playlist URLs) is redacted;
//   - the token belongs to a non-admin viewer user (internal/jellyfin), and an
//     allowlist of consumption endpoints still applies (defense in depth; a
//     pre-#50 install runs on an admin API key until it reconnects);
//   - every request is pinned to the token's Jellyfin user (userId).
type Jellyfin struct {
	Client *http.Client
	URL    string // e.g. http://localhost:8096
	// Status is the body of the gateway API's GET /streamiq/status, built on each
	// request. ponytail: lives here because the tunnel has one config struct.
	Status func() any

	cred atomic.Pointer[cred] // SetKey; may arrive after start (internal/jellyfin)
}

type cred struct{ key, userID string }

// SetKey installs the token and the Jellyfin user id it belongs to. Safe
// while sessions run.
func (j *Jellyfin) SetKey(key, userID string) { j.cred.Store(&cred{key, userID}) }

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

// prepare turns a browser request frame into the origin request, or returns
// the HTTP status to refuse it with.
func (j *Jellyfin) prepare(rq tunnelReq) (*http.Request, int, error) {
	c := j.current()
	if c.key == "" || c.userID == "" {
		return nil, http.StatusServiceUnavailable, fmt.Errorf("no Jellyfin token yet (see the gateway's local page)")
	}
	u, err := url.Parse(rq.URL)
	if err != nil || u.IsAbs() || u.RawPath != "" || u.Path != path.Clean(u.Path) ||
		!allow(rq.Method, u.Path) {
		return nil, http.StatusForbidden, fmt.Errorf("refused %s %s", rq.Method, rq.URL)
	}
	if len(rq.Body) > MaxBody {
		return nil, http.StatusRequestEntityTooLarge, fmt.Errorf("body %d bytes", len(rq.Body))
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
	if rq.Body != "" {
		body = strings.NewReader(rq.Body)
	}
	req, err := http.NewRequest(rq.Method, j.URL+u.String(), body)
	if err != nil {
		return nil, http.StatusBadRequest, err
	}
	for k, v := range rq.Headers {
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
	if rq.Body != "" && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", `MediaBrowser Token="`+c.key+`"`)
	return req, 0, nil
}

// redact buffers text responses (JSON, playlists) and removes the token.
// Media (video/*, image/*) streams through untouched.
func (j *Jellyfin) redact(hdr map[string]string, body io.ReadCloser) (io.ReadCloser, error) {
	ct := strings.ToLower(hdr["Content-Type"])
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
	if k := j.current().key; k != "" {
		b = bytes.ReplaceAll(b, []byte(k), []byte("redacted"))
	}
	hdr["Content-Length"] = fmt.Sprint(len(b))
	return io.NopCloser(bytes.NewReader(b)), nil
}
