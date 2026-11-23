package history

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"streamiq/gateway/internal/tunnel"
	"streamiq/protocol"
)

func api(t *Tunnels) *tunnel.Router {
	rt := tunnel.NewRouter()
	rt.Handle("GET "+TunnelsPath, http.HandlerFunc(t.ServeList))
	rt.Handle("GET "+SummaryPath, http.HandlerFunc(t.ServeSummary), tunnel.AdminOnly)
	rt.Handle("POST "+ThroughputPath, http.HandlerFunc(ServeThroughput))
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
	h := &Tunnels{Store: s}
	end := time.Now().UTC()
	r := protocol.Report{Session: "s1", Relay: true, Ipv6: true, BytesSent: 10, BytesReceived: 20,
		Use: "playback", ActiveMs: ref(int64(900))}
	if err := h.Record(r, "u1", end.Add(-time.Minute), end, 4200); err != nil {
		t.Fatal(err)
	}
	if err := h.Record(protocol.Report{Session: "s2", Failure: ref("ice failed")}, "u1", end, end, 0); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(s.Dir, "tunnels-"+end.Format(day)+".jsonl"))
	want := fmt.Sprintf(`{"id":"s1","createdAt":%q,"endedAt":%q,"userId":"u1","relay":true,"ipv6":true,`+
		`"bytesSent":10,"bytesReceived":20,"throughputKbps":4200,"failure":null,"use":"playback","activeMs":900}`+"\n"+
		`{"id":"s2","createdAt":%[2]q,"endedAt":%[2]q,"userId":"u1","relay":false,"ipv6":false,`+
		`"bytesSent":0,"bytesReceived":0,"throughputKbps":null,"failure":"ice failed","use":null,"activeMs":null}`+"\n",
		end.Add(-time.Minute).Format(time.RFC3339Nano), end.Format(time.RFC3339Nano))
	if string(b) != want {
		t.Fatalf("lines\n%s\nwant\n%s", b, want)
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
	h := &Tunnels{Store: &Store{Dir: t.TempDir(), Kind: "tunnels", Days: 40}}
	now := time.Now()
	add := func(at time.Time, user string, r protocol.Report) {
		if err := h.Record(r, user, at, at, 0); err != nil {
			t.Fatal(err)
		}
	}
	add(now.AddDate(0, 0, -31), "u2", protocol.Report{Session: "old"})
	for i := range n {
		at := now.Add(-time.Duration(n-i) * time.Minute)
		add(at, "u2", protocol.Report{Session: fmt.Sprint("m", i), Use: "playback"})
	}
	add(now.Add(-time.Hour), "u1", protocol.Report{Session: "a1", Use: "management"})
	add(now.Add(-2*time.Hour), "u1", protocol.Report{Session: "a2", Use: "diagnostics", Failure: ref("ice failed")})
	add(now.Add(-3*time.Hour), "u1", protocol.Report{Session: "a3", Relay: true, BytesSent: 5, BytesReceived: 7})
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

func TestThroughputGoesToTheCallersOwnTunnel(t *testing.T) {
	rt := api(&Tunnels{})
	for body, want := range map[string]int{`{"throughputKbps":4200}`: 4200, `{"throughputKbps":-1}`: 0, `{}`: 0} {
		use := tunnel.NewUsage(t0)
		use.SetThroughput(1) // the last report wins, also one without a measurement
		status, _, _, _ := tunnel.Do(rt, tunnel.Session{Use: use}, "POST", ThroughputPath, body)
		if status != http.StatusNoContent || use.Throughput() != want {
			t.Errorf("%s: %d, kept %d, want %d", body, status, use.Throughput(), want)
		}
	}
	if status, _, _, _ := tunnel.Do(rt, tunnel.Session{}, "POST", ThroughputPath, "nope"); status != http.StatusBadRequest {
		t.Fatalf("a bad body: %d", status)
	}
}
