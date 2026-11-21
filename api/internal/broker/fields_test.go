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

func TestClip(t *testing.T) {
	x := strings.Repeat
	for _, c := range []struct {
		in   *string
		max  int
		want any
	}{
		{nil, 16, nil}, {p("udp"), 16, "udp"}, {p("u\x01p"), 16, nil}, {p("\x00"), 16, nil},
		{p(x("x", 14) + "😀"), 16, x("x", 14) + "😀"}, // 16 units: kept whole
		{p(x("x", 17)), 16, x("x", 16)}, {p(x("x", 15) + "😀"), 16, x("x", 15)}, {p(x("x", 70)), 64, x("x", 64)},
	} {
		if got := deref(clip(c.in, c.max)); got != c.want {
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
		"update":"1.6.0","name":" nas ","telemetry":"full"}`))
	want := heartbeat{2, p("http://nas.local:8096/"), p("1.4.0"), p("1.6.0"), p("nas"), p("full")}
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

// Missing = a gateway too old to send it; any other value, even of the wrong type, is off.
func TestTelemetryLevel(t *testing.T) {
	for s, want := range map[string]any{
		`{"telemetry":"full"}`: "full", `{"telemetry":"off"}`: "off", `{"telemetry":"basic"}`: "off",
		`{"telemetry":"FULL"}`: "off", `{"telemetry":5}`: "off", `{"telemetry":null}`: nil, `{}`: nil,
	} {
		if got := deref(parseHeartbeat(msg(t, s)).Tel); got != want {
			t.Errorf("%s: %v", s, got)
		}
	}
}

func TestHealthParsesEveryField(t *testing.T) {
	got := parseHealth(
		msg(t, `{"health":{"jellyfin":{"reachable":true,"version":"10.11.2"},"os":"windows","arch":"amd64",
		"transcoding":"nvenc","offline":"enforced","tunnels":1,"transcodes":0,"cpu":12.5,"memory":47.3,"disk":5}}`),
	)
	want := health{
		p(true),
		p("10.11.2"),
		p("windows"),
		p("amd64"),
		p("nvenc"),
		p("enforced"),
		nil,
		p(1),
		p(0),
		p(12.5),
		p(47.3),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%+v", got)
	}
}

// Out of bounds = nil, never cut or clamped.
func TestHealthFieldsOutOfBoundsOrOfTheWrongTypeAreNil(t *testing.T) {
	s := `{"health":{"jellyfin":{"reachable":"yes","version":"V41"},"os":"X21","arch":"a\u0000",
		"transcoding":5,"offline":"","tunnels":-1,"transcodes":10001,"cpu":100.1,"memory":-0.5}}`
	s = strings.NewReplacer("V41", strings.Repeat("9", 41), "X21", strings.Repeat("x", 21)).Replace(s)
	if got := parseHealth(msg(t, s)); !reflect.DeepEqual(got, health{}) {
		t.Fatalf("%+v", got)
	}
}

func TestMissingHealthIsAllNil(t *testing.T) {
	for _, s := range []string{`{}`, `{"health":5}`, `{"health":{"jellyfin":[]}}`} {
		if got := parseHealth(msg(t, s)); !reflect.DeepEqual(got, health{}) {
			t.Errorf("%s: %+v", s, got)
		}
	}
}

func TestHealthAtTheBoundsIsKept(t *testing.T) {
	s := `{"health":{"jellyfin":{"version":"` + strings.Repeat("9", 40) + `"},"os":"` + strings.Repeat("x", 20) + `",
		"tunnels":10000,"transcodes":0,"cpu":0,"memory":100}}`
	want := health{JellyfinVersion: p(strings.Repeat("9", 40)), Os: p(strings.Repeat("x", 20)), Tunnels: p(10000),
		Transcodes: p(0), CPU: p(0.0), Memory: p(100.0)}
	if got := parseHealth(msg(t, s)); !reflect.DeepEqual(got, want) {
		t.Fatalf("%+v", got)
	}
}

const sid = "6f9619ff-8b86-d011-b42d-00cf4fc964ff"

func TestReportParsesEveryField(t *testing.T) {
	got := parseReport(msg(t, `{"type":"tunnel","session":"`+sid+`","bytesSent":10,"bytesReceived":20,"relay":true,
		"ipv6":true,"localCandidateType":"host","remoteCandidateType":"srflx","protocol":"udp","failure":"ice failed",
		"use":"a-future-use-name-cut","activeMs":1234}`))
	want := &report{
		sid,
		10,
		20,
		true,
		true,
		p("host"),
		p("srflx"),
		p("udp"),
		p("ice failed"),
		p("a-future-use-nam"),
		p[int64](1234),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%+v", got)
	}
}

func TestReportOptionalFieldsOfTheWrongTypeReadAsMissing(t *testing.T) {
	got := parseReport(msg(t, `{"session":"`+sid+`","bytesSent":0,"bytesReceived":0,"relay":"yes","ipv6":1,
		"localCandidateType":5,"remoteCandidateType":[],"protocol":{},"failure":false,"use":3,"activeMs":-5}`))
	if !reflect.DeepEqual(got, &report{Session: sid}) {
		t.Fatalf("%+v", got)
	}
	if r := parseReport(msg(t, `{"session":"`+sid+`","bytesSent":0,"bytesReceived":0,"use":""}`)); r.Use != nil {
		t.Fatal("empty use kept")
	}
}

func TestReportWithoutSessionOrByteCountsIsNil(t *testing.T) {
	for _, s := range []string{
		`{"bytesSent":1,"bytesReceived":1}`, `{"session":"nope","bytesSent":1,"bytesReceived":1}`,
		`{"session":5,"bytesSent":1,"bytesReceived":1}`, `{"session":"S","bytesReceived":1}`,
		`{"session":"S","bytesSent":"1","bytesReceived":1}`, `{"session":"S","bytesSent":-1,"bytesReceived":1}`,
		`{"session":"S","bytesSent":1,"bytesReceived":-1}`, `{"session":"S","bytesSent":1.5,"bytesReceived":1}`,
	} {
		if r := parseReport(msg(t, strings.ReplaceAll(s, `"S"`, `"`+sid+`"`))); r != nil {
			t.Errorf("%s: %+v", s, r)
		}
	}
}

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
