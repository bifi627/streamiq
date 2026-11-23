package broker

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// Untrusted socket messages parse without a database. A field of the wrong JSON type
// reads as missing; whole values are compared, so two swapped fields fail. Gateway
// strings never reach Postgres or the web app in a form they refuse.

func msg(t *testing.T, s string) Fields {
	t.Helper()
	var m Fields
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func p[T any](v T) *T { return &v }

func deref(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func TestSafeName(t *testing.T) {
	x := strings.Repeat
	for _, c := range []struct {
		in   *string
		want any
	}{
		{p("  Living room  "), "Living room"}, {p(""), nil}, {p("   "), nil}, {nil, nil}, {p("a\x00b"), nil}, {p("a\nb"), nil},
		{p(x("x", 120)), x("x", 100)}, {p(x("x", 100)), x("x", 100)},
		{p(x("x", 99) + "😀😀"), x("x", 99)}, // never between a surrogate pair
		{p(x("x", 98) + "😀"), x("x", 98) + "😀"},
	} {
		if got := deref(safeName(c.in)); got != c.want {
			t.Errorf("%v: %v", deref(c.in), got)
		}
	}
}

func TestSafeLanURLAllowsOnlyHTTP(t *testing.T) {
	long := "http://h/" + strings.Repeat("a", 191)
	for in, want := range map[string]any{
		"http://192.168.1.20:8096": "http://192.168.1.20:8096/", "https://nas.local/": "https://nas.local/",
		"HTTP://NAS.local/x": "http://nas.local/x", "javascript:alert(1)": nil, "ftp://nas.local/": nil, "not a url": nil,
		"http:nas": nil, long: long, long + "a": nil,
	} {
		if got := deref(safeLanURL(&in)); got != want {
			t.Errorf("%s: %v", in, got)
		}
	}
	if safeLanURL(nil) != nil {
		t.Error("nil")
	}
}

func TestHeartbeatParsesEveryField(t *testing.T) {
	got := parseHeartbeat(msg(t, `{"type":"heartbeat","protocol":2,"lanUrl":"http://nas.local:8096","version":"1.4.0",
		"update":"1.6.0","name":" nas "}`))
	want := heartbeat{2, p("http://nas.local:8096/"), p("1.4.0"), p("1.6.0"), p("nas")}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%+v", got)
	}
}

func TestHeartbeatFieldsOfTheWrongTypeReadAsMissing(t *testing.T) {
	got := parseHeartbeat(msg(t, `{"type":"heartbeat","protocol":1,"lanUrl":5,"version":true,"update":[],"name":5}`))
	if !reflect.DeepEqual(got, heartbeat{Protocol: 1}) {
		t.Fatalf("%+v", got)
	}
}

// An old gateway's other fields can't skip the "update required" write: its protocol
// reads as 0 whatever else it sent.
func TestHeartbeatProtocolMissingOrNotAnIntIsZero(t *testing.T) {
	for _, s := range []string{`{"name":5,"lanUrl":{}}`, `{"protocol":"1","name":5}`, `{"protocol":1.5}`, `{"protocol":null}`} {
		if protocolOf(msg(t, s)) != 0 || parseHeartbeat(msg(t, s)).Protocol != 0 {
			t.Error(s)
		}
	}
}

func TestHeartbeatVersionAndUpdateLimits(t *testing.T) {
	v41, u40 := strings.Repeat("1", 41), strings.Repeat("1", 40)
	for s, want := range map[string][2]any{
		`{"version":""}`: {"", nil}, `{"update":""}`: {nil, nil},
		`{"version":"` + v41 + `"}`: {nil, nil}, `{"update":"` + u40 + `"}`: {nil, u40},
	} {
		h := parseHeartbeat(msg(t, s))
		if got := [2]any{deref(h.Version), deref(h.Update)}; got != want {
			t.Errorf("%s: %v", s, got)
		}
	}
}

const sid = "6f9619ff-8b86-d011-b42d-00cf4fc964ff"

// A malformed or wrong-typed gateway id reads as missing: "gateway offline or unknown".
func TestIDsAndTypes(t *testing.T) {
	for s, want := range map[string]string{
		`{"gatewayId":"` + sid + `"}`: sid, `{"gatewayId":"` + strings.ToUpper(sid) + `"}`: sid,
		`{"gatewayId":5}`: "", `{"gatewayId":"nope"}`: "", `{}`: "",
	} {
		if got := id(msg(t, s), "gatewayId"); got != want {
			t.Errorf("%s: %q", s, got)
		}
	}
	if str(msg(t, `{"type":5}`), "type") != "" {
		t.Error("a number read as a type")
	}
	if c := ptr[json.RawMessage](
		msg(t, `{"candidate":{"candidate":"c"}}`),
		"candidate",
	); string(
		*c,
	) != `{"candidate":"c"}` {
		t.Error("candidate not kept as sent")
	}
}
