package history

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"streamiq/protocol"
)

var t0 = time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)

type rec struct{ N int }

func TestAppendReadAndRetention(t *testing.T) {
	s := &Store{Dir: filepath.Join(t.TempDir(), Dir), Kind: "x"}
	for i := range 10 { // one record a day: 10 days
		if err := s.Append(t0.AddDate(0, 0, i), rec{i}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := Read[rec](s)
	if err != nil {
		t.Fatal(err)
	}
	// Today (day 9) and the 7 days before it are kept.
	if len(got) != KeepDays+1 || got[0].N != 2 || got[len(got)-1].N != 9 {
		t.Fatalf("got %v, want days 2..9", got)
	}
	if _, err := os.Stat(filepath.Join(s.Dir, "x-2026-11-29.jsonl")); err != nil {
		t.Fatal(err)
	}
}

func TestATornLineIsSkippedAndNotGluedOnto(t *testing.T) {
	s := &Store{Dir: t.TempDir(), Kind: "x"}
	if err := s.Append(t0, rec{1}); err != nil {
		t.Fatal(err)
	}
	f, _ := os.OpenFile(s.file(t0), os.O_APPEND|os.O_WRONLY, 0)
	_, _ = f.WriteString(`{"N":`) // a crash mid-write
	f.Close()
	if err := s.Append(t0, rec{2}); err != nil {
		t.Fatal(err)
	}
	got, err := Read[rec](s)
	if err != nil || len(got) != 2 || got[0].N != 1 || got[1].N != 2 {
		t.Fatalf("got %v %v, want [1 2]", got, err)
	}
}

func TestTheRateRule(t *testing.T) {
	dir := t.TempDir()
	h := func() *Health { return &Health{Store: &Store{Dir: dir, Kind: "health"}, Version: "1.4.0"} }
	up := protocol.Health{Jellyfin: protocol.Jellyfin{Reachable: true, Version: "10.11.2"}, OS: "linux"}
	down := up
	down.Jellyfin.Reachable = false
	r := h()
	for _, c := range []struct {
		after time.Duration
		h     protocol.Health
	}{
		{0, up},                              // first: a row
		{30 * time.Second, up},               // nothing changed: none
		{40 * time.Second, down},             // Jellyfin changed: a row
		{50 * time.Second, up},               // within 25 s of the last row: none
		{70 * time.Second, up},               // changed back: a row
		{6*time.Minute + 10*time.Second, up}, // 5 min old: a row
	} {
		if err := r.Record(t0.Add(c.after), c.h); err != nil {
			t.Fatal(err)
		}
	}
	// A restarted gateway goes on from the stored latest row.
	if err := h().Record(t0.Add(6*time.Minute+40*time.Second), up); err != nil {
		t.Fatal(err)
	}
	got, _ := Read[entry](r.Store)
	want := []time.Duration{0, 40 * time.Second, 70 * time.Second, 6*time.Minute + 10*time.Second}
	if len(got) != len(want) {
		t.Fatalf("%d rows, want %d: %v", len(got), len(want), got)
	}
	for i, w := range want {
		if !got[i].At.Equal(t0.Add(w)) {
			t.Errorf("row %d at %v, want %v", i, got[i].At, t0.Add(w))
		}
	}
}

func TestTheWindowIsLedByTheRowBeforeIt(t *testing.T) {
	rows := []entry{
		{At: t0.Add(-Window - 2*time.Hour)},                        // before the lead: left out
		{At: t0.Add(-Window - time.Hour), GatewayVersion: "1.3.0"}, // the lead
		{At: t0.Add(-time.Minute)},
		{At: t0.Add(-time.Hour)}, // written after a clock went back: answered in order
	}
	got := window(rows, t0)
	if len(got) != 3 || *got[0].GatewayVersion != "1.3.0" || !got[1].At.Equal(t0.Add(-time.Hour)) {
		t.Fatalf("got %+v", got)
	}
	if got := window(rows[:2], t0); len(got) != 1 || *got[0].GatewayVersion != "1.3.0" {
		t.Fatalf("only older rows: the latest leads, got %+v", got)
	}
}

func TestTheEndpointAnswersTodaysShape(t *testing.T) {
	now := time.Now().UTC()
	s := &Store{Dir: t.TempDir(), Kind: "health"}
	cpu := 12.5
	for _, e := range []entry{
		{At: now.Add(-time.Minute), GatewayVersion: "1.4.0", Health: protocol.Health{
			Jellyfin: protocol.Jellyfin{Reachable: true, Version: "10.11.2"}, Tunnels: 2, CPU: &cpu,
		}},
		{At: now},
	} {
		if err := s.Append(e.At, e); err != nil {
			t.Fatal(err)
		}
	}
	w := httptest.NewRecorder()
	(&Health{Store: s}).ServeHTTP(w, httptest.NewRequest(http.MethodGet, HealthPath, nil))
	var got []HealthRow
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK || len(got) != 2 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	r := got[0]
	if !*r.JellyfinReachable || *r.JellyfinVersion != "10.11.2" || *r.GatewayVersion != "1.4.0" ||
		*r.Tunnels != 2 || *r.CPU != cpu || r.Transcodes != nil || r.Memory != nil {
		t.Fatalf("first row %s", w.Body)
	}
	if got[1].JellyfinVersion != nil || got[1].GatewayVersion != nil {
		t.Fatalf("an empty version is null: %s", w.Body)
	}
}

func TestAnEmptyHistoryIsAnEmptyList(t *testing.T) {
	w := httptest.NewRecorder()
	h := &Health{Store: &Store{Dir: t.TempDir(), Kind: "health"}}
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, HealthPath, nil))
	if w.Code != http.StatusOK || w.Body.String() != "[]" {
		t.Fatalf("%d %q", w.Code, w.Body)
	}
}
