package broker

import (
	"encoding/json"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf16"

	"github.com/google/uuid"
)

// The messages are untrusted, so each field is read on its own: a field of the wrong
// JSON type reads as missing, never an error that drops the whole message (which
// decoding into protocol's types would). Lengths count UTF-16 units, as the web app does.

// field is m[key] as T; missing, null or of another JSON type = false.
func field[T any](m Fields, key string) (v T, ok bool) {
	raw, found := m[key]
	if !found || string(raw) == "null" || json.Unmarshal(raw, &v) != nil {
		return v, false
	}
	return v, true
}

// ptr is field as a pointer, nil = missing.
func ptr[T any](m Fields, key string) *T {
	if v, ok := field[T](m, key); ok {
		return &v
	}
	return nil
}

func str(m Fields, key string) string {
	s, _ := field[string](m, key)
	return s
}

// id is a uuid field, "" when missing or malformed.
func id(m Fields, key string) string {
	u, err := uuid.Parse(str(m, key))
	if err != nil {
		return ""
	}
	return u.String()
}

func object(m Fields, key string) Fields {
	o, _ := field[Fields](m, key)
	return o
}

func units(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

// cut is s cut to limit UTF-16 units, never inside a surrogate pair (Postgres takes no
// lone one).
func cut(s string, limit int) string {
	n := 0
	for i, r := range s {
		if n += utf16.RuneLen(r); n > limit {
			return s[:i]
		}
	}
	return s
}

func hasControl(s string) bool { return strings.ContainsFunc(s, unicode.IsControl) }

// clip keeps a gateway-supplied string short and Postgres-safe: nil when missing or with
// a control character (Postgres text refuses NUL).
func clip(s *string, limit int) *string {
	if s == nil || hasControl(*s) {
		return nil
	}
	c := cut(*s, limit)
	return &c
}

// bounded is nil when s is missing, empty, over limit or has a control character; never cut.
func bounded(s *string, limit int) *string {
	if s == nil || *s == "" || units(*s) > limit || hasControl(*s) {
		return nil
	}
	return s
}

// safeName: the gateway owns its name. Missing or blank (an older gateway) or with a
// control character = nil: keep the stored name. Cut to 100.
func safeName(s *string) *string {
	if s == nil {
		return nil
	}
	n := strings.TrimSpace(*s)
	if n == "" || hasControl(n) {
		return nil
	}
	n = cut(n, 100)
	return &n
}

// safeLanURL: the web app renders it as a link, so only plain http(s) URLs, never
// javascript: etc.
func safeLanURL(s *string) *string {
	if s == nil || units(*s) > 200 {
		return nil
	}
	u, err := url.Parse(*s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil
	}
	u.Host = strings.ToLower(u.Host)
	if u.Path == "" {
		u.Path = "/"
	}
	out := u.String()
	return &out
}

// heartbeat is a heartbeat (docs/protocol.md), its strings already cleaned.
type heartbeat struct {
	Protocol                           int
	LanURL, Version, Update, Name, Tel *string
}

// protocolOf: missing or not an integer = 0 (a gateway too old to send it).
func protocolOf(m Fields) int {
	p, _ := field[int](m, "protocol")
	return p
}

func parseHeartbeat(m Fields) heartbeat {
	h := heartbeat{
		Protocol: protocolOf(m),
		LanURL:   safeLanURL(ptr[string](m, "lanUrl")),
		Name:     safeName(ptr[string](m, "name")),
		Tel:      levelOf(m),
	}
	if v := ptr[string](m, "version"); v != nil && units(*v) <= 40 {
		h.Version = v
	}
	if u := ptr[string](m, "update"); u != nil && *u != "" && units(*u) <= 40 {
		h.Update = u
	}
	return h
}

const levelFull, levelOff = "full", "off"

// levelOf: missing (or null) = nil, a gateway too old to send it; anything but `full` = `off`.
func levelOf(m Fields) *string {
	raw, ok := m["telemetry"]
	if !ok || string(raw) == "null" {
		return nil
	}
	l := levelOff
	if str(m, "telemetry") == levelFull {
		l = levelFull
	}
	return &l
}

// health is a `full` heartbeat's `health`, each field out of bounds or of the wrong
// type = nil. GatewayVersion is the heartbeat's version.
type health struct {
	JellyfinReachable                                         *bool
	JellyfinVersion, Os, Arch, Transcoding, Offline, GatewayV *string
	Tunnels, Transcodes                                       *int
	CPU, Memory                                               *float64
}

func parseHealth(m Fields) health {
	h := object(m, "health")
	jf := object(h, "jellyfin")
	return health{
		JellyfinReachable: ptr[bool](jf, "reachable"),
		JellyfinVersion:   bounded(ptr[string](jf, "version"), 40),
		Os:                bounded(ptr[string](h, "os"), 20),
		Arch:              bounded(ptr[string](h, "arch"), 20),
		Transcoding:       bounded(ptr[string](h, "transcoding"), 20),
		Offline:           bounded(ptr[string](h, "offline"), 20),
		Tunnels:           count(h, "tunnels"),
		Transcodes:        count(h, "transcodes"),
		CPU:               percent(h, "cpu"),
		Memory:            percent(h, "memory"),
	}
}

// count: ponytail: 10 000 is far above any household's tunnels or transcodes.
func count(h Fields, key string) *int {
	if n := ptr[int](h, key); n != nil && *n >= 0 && *n <= 10_000 {
		return n
	}
	return nil
}

func percent(h Fields, key string) *float64 {
	if p := ptr[float64](h, key); p != nil && *p >= 0 && *p <= 100 {
		return p
	}
	return nil
}

// report is a gateway's report of one tunnel when it ends.
type report struct {
	Session                         string
	Sent, Received                  int64
	Relay, Ipv6                     bool
	Local, Remote, Protocol, Failed *string
	Use                             *string
	ActiveMs                        *int64
}

// parseReport is nil without a session or with byte counts missing or negative.
func parseReport(m Fields) *report {
	sent, okS := field[int64](m, "bytesSent")
	received, okR := field[int64](m, "bytesReceived")
	session := id(m, "session")
	if session == "" || !okS || !okR || sent < 0 || received < 0 {
		return nil
	}
	r := &report{
		Session: session, Sent: sent, Received: received,
		Local:    clip(ptr[string](m, "localCandidateType"), 16),
		Remote:   clip(ptr[string](m, "remoteCandidateType"), 16),
		Protocol: clip(ptr[string](m, "protocol"), 16),
		Failed:   clip(ptr[string](m, "failure"), 64),
	}
	r.Relay, _ = field[bool](m, "relay")
	r.Ipv6, _ = field[bool](m, "ipv6")
	if u := clip(ptr[string](m, "use"), 16); u != nil && *u != "" {
		r.Use = u
	}
	if a := ptr[int64](m, "activeMs"); a != nil && *a >= 0 {
		r.ActiveMs = a
	}
	return r
}
