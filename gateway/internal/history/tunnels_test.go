package history

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"streamiq/gateway/internal/tunnel"
)

func api(t *Tunnels) *tunnel.Router {
	rt := tunnel.NewRouter()
	rt.Handle("GET "+TunnelsPath, http.HandlerFunc(t.ServeList))
	rt.Handle("GET "+SummaryPath, http.HandlerFunc(t.ServeSummary), tunnel.AdminOnly)
	return rt
}

func get[T any](t *testing.T, rt *tunnel.Router, who tunnel.Session, url string) (int, T) {
	t.Helper()
	status, _, body, _ := tunnel.Do(rt, who, "GET", url, "")
	var v T
	if status == http.StatusOK {
		if err := json.Unmarshal([]byte(body), &v); err != nil {
			t.Fatal(err)
		}
	}
	return status, v
}

func ref[T any](v T) *T { return &v }

func TestATunnelLineHasEveryField(t *testing.T) {
	s := &Store{Dir: t.TempDir(), Kind: "tunnels", Days: TunnelDays}
	h := &Tunnels{Store: s, Gateway: "g1"}
	end := time.Now().UTC()
	r := tunnel.Report{Session: "s1", Relay: true, Ipv6: true, BytesSent: 10, BytesReceived: 20,
		Use: "playback", ActiveMs: ref(int64(900))}
	if err := h.Record(r, "u1", end.Add(-time.Minute), end, 4200, nil); err != nil {
		t.Fatal(err)
	}
	if err := h.Record(tunnel.Report{Session: "s2", Failure: ref("ice failed")}, "u1", end, end, 0, nil); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(s.Dir, "tunnels-"+end.Format(day)+".jsonl"))
	want := fmt.Sprintf(`{"id":"s1","gatewayId":"g1","createdAt":%q,"endedAt":%q,`+
		`"userId":"u1","relay":true,"ipv6":true,`+
		`"bytesSent":10,"bytesReceived":20,"throughputKbps":4200,"failure":null,"use":"playback","activeMs":900}`+"\n"+
		`{"id":"s2","gatewayId":"g1","createdAt":%[2]q,"endedAt":%[2]q,"userId":"u1","relay":false,"ipv6":false,`+
		`"bytesSent":0,"bytesReceived":0,"throughputKbps":null,"failure":"ice failed","use":null,"activeMs":null}`+"\n",
		end.Add(-time.Minute).Format(time.RFC3339Nano), end.Format(time.RFC3339Nano))
	if string(b) != want {
		t.Fatalf("lines\n%s\nwant\n%s", b, want)
	}
}

// A line keeps its playbacks and GET answers them; a line without any answers none.
func TestTheLinesPlaybacks(t *testing.T) {
	h := &Tunnels{Store: &Store{Dir: t.TempDir(), Kind: "tunnels", Days: TunnelDays}, Gateway: "g1"}
	now := time.Now()
	p := tunnel.Playback{ItemID: "it", Codec: "hevc", Width: 1920, Height: 1080, Quality: "Source", Remux: true,
		PlayedSec: 720, DroppedFrames: 312, TotalFrames: 43210, WorstStallMs: 840, Waits: 3}
	if err := h.Record(tunnel.Report{Session: "old"}, "u1", now.Add(-time.Minute), now, 0, nil); err != nil {
		t.Fatal(err)
	}
	if err := h.Record(tunnel.Report{Session: "new"}, "u1", now, now, 0, []tunnel.Playback{p, p}); err != nil {
		t.Fatal(err)
	}
	status, _, body, _ := tunnel.Do(api(h), tunnel.Session{User: "u1"}, "GET", TunnelsPath, "")
	var rows []Tunnel
	if err := json.Unmarshal([]byte(body), &rows); err != nil || status != 200 || len(rows) != 2 {
		t.Fatalf("%d %s", status, body)
	}
	if len(rows[0].Playbacks) != 2 || rows[0].Playbacks[1] != p || rows[1].Playbacks != nil ||
		!strings.Contains(body, `"playbacks":[{"itemId":"it"`) || strings.Count(body, "playbacks") != 1 {
		t.Fatalf("got %s", body)
	}
}

func TestTheTunnelsKeep30Days(t *testing.T) {
	s := &Store{Dir: t.TempDir(), Kind: "tunnels", Days: TunnelDays}
	for i := range 32 {
		if err := s.Append(t0.AddDate(0, 0, i), rec{i}); err != nil {
			t.Fatal(err)
		}
	}
	if got, _ := Read[rec](s); len(got) != 31 || got[0].N != 1 {
		t.Fatalf("got %d days from %v, want today and the 30 before", len(got), got[0])
	}
}

// seed writes lines for users u1 (admin) and u2 (member), one older than 30 days.
func seed(t *testing.T, n int) *Tunnels {
	t.Helper()
	h := &Tunnels{Store: &Store{Dir: t.TempDir(), Kind: "tunnels", Days: 40}, Gateway: "g2"}
	now := time.Now()
	add := func(at time.Time, user string, r tunnel.Report) {
		if err := h.Record(r, user, at, at, 0, nil); err != nil {
			t.Fatal(err)
		}
	}
	add(now.AddDate(0, 0, -31), "u2", tunnel.Report{Session: "old"})
	before := *h
	before.Gateway = "g1" // the same box, enrolled earlier (maybe in another household)
	if err := before.Record(tunnel.Report{Session: "earlier"}, "u0", now, now, 0, nil); err != nil {
		t.Fatal(err)
	}
	for i := range n {
		at := now.Add(-time.Duration(n-i) * time.Minute)
		add(at, "u2", tunnel.Report{Session: fmt.Sprint("m", i), Use: "playback"})
	}
	add(now.Add(-time.Hour), "u1", tunnel.Report{Session: "a1", Use: "management"})
	add(now.Add(-2*time.Hour), "u1", tunnel.Report{Session: "a2", Use: "diagnostics", Failure: ref("ice failed")})
	add(now.Add(-3*time.Hour), "u1", tunnel.Report{Session: "a3", Relay: true, BytesSent: 5, BytesReceived: 7})
	return h
}

var (
	admin  = tunnel.Session{User: "u1", Role: tunnel.Admin}
	member = tunnel.Session{User: "u2", Role: tunnel.Member}
)

func TestAMemberGetsTheirOwnTunnelsNewestFirst(t *testing.T) {
	rt := api(seed(t, 3))
	status, rows := get[[]Tunnel](t, rt, member, TunnelsPath)
	if status != http.StatusOK || len(rows) != 3 || rows[0].ID != "m2" || rows[2].ID != "m0" {
		t.Fatalf("%d %+v", status, rows)
	}
	for _, r := range rows {
		if r.UserID != "" {
			t.Fatalf("own scope answers a userId: %+v", r)
		}
	}
	if status, _ := get[[]Tunnel](t, rt, member, TunnelsPath+"?scope=household"); status != http.StatusForbidden {
		t.Fatalf("a member's household scope: %d, want 403", status)
	}
	if status, _ := get[[]Tunnel](t, rt, admin, TunnelsPath+"?scope=mine"); status != http.StatusBadRequest {
		t.Fatalf("an unknown scope: %d, want 400", status)
	}
}

func TestAnAdminGetsTheHouseholdCapped(t *testing.T) {
	rt := api(seed(t, TunnelLimit))
	_, rows := get[[]Tunnel](t, rt, admin, TunnelsPath+"?scope=household")
	if len(rows) != TunnelLimit || rows[0].ID != fmt.Sprint("m", TunnelLimit-1) || rows[0].UserID != "u2" {
		t.Fatalf("%d rows, first %+v", len(rows), rows[0])
	}
	if _, own := get[[]Tunnel](t, rt, admin, TunnelsPath); len(own) != 3 || own[0].ID != "a1" {
		t.Fatalf("an admin's own scope: %+v", own)
	}
}

func TestTheSummaryCountsEveryLineOf30Days(t *testing.T) {
	rt := api(seed(t, TunnelLimit))
	if status, _ := get[[]Summary](t, rt, member, SummaryPath); status != http.StatusForbidden {
		t.Fatalf("a member's summary: %d, want 403", status)
	}
	_, got := get[[]Summary](t, rt, admin, SummaryPath)
	want := []Summary{
		{UserID: "u2", Tunnels: TunnelLimit},
		{UserID: "u1", Tunnels: 3, Hidden: 1, Failed: 1, RelayedBytes: 12},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("summary %+v, want %+v", got, want)
	}
}
