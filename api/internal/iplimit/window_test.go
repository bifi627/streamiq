package iplimit

import (
	"testing"
	"time"
)

func TestAClientsBudgetComesBackOneMinuteAfterTheWindowOpened(t *testing.T) {
	l := New(1, "")
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	got := []bool{
		l.allow("a", t0), l.allow("a", t0.Add(59*time.Second)),
		l.allow("a", t0.Add(time.Minute)), l.allow("a", t0.Add(time.Minute+time.Second)),
	}
	want := []bool{true, false, true, false}
	for i := range want {
		if got[i] != want[i] {
			t.Fatal(got)
		}
	}
}
