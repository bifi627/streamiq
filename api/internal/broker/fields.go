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
	Protocol                      int
	LanURL, Version, Update, Name *string
	RelayOff                      bool // missing (an older gateway) = relay on
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
	}
	h.RelayOff, _ = field[bool](m, "relayOff")
	if v := ptr[string](m, "version"); v != nil && units(*v) <= 40 {
		h.Version = v
	}
	if u := ptr[string](m, "update"); u != nil && *u != "" && units(*u) <= 40 {
		h.Update = u
	}
	return h
}
