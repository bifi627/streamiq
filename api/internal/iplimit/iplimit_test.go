package iplimit_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"streamiq/api/internal/iplimit"
)

func TestEveryWrappedHandlerSpendsOneBudgetPerClientIP(t *testing.T) {
	l := iplimit.New(2, "X-Real-IP")
	ok := func(w http.ResponseWriter, _ *http.Request) {}
	a, b := l.Wrap(ok), l.Wrap(ok)
	status := func(h http.HandlerFunc, ip string) int {
		rq := httptest.NewRequest(http.MethodGet, "/", nil)
		if ip != "" {
			rq.Header.Set("X-Real-IP", ip)
		}
		rs := httptest.NewRecorder()
		h(rs, rq)
		return rs.Code
	}
	got := []int{
		status(a, "203.0.113.1"), status(b, "203.0.113.1"), status(a, "203.0.113.1"),
		status(b, "203.0.113.2"),
		status(a, ""), status(a, ""), status(b, ""), // no header: the connection's address
	}
	want := []int{200, 200, 429, 200, 200, 200, 429}
	for i := range want {
		if got[i] != want[i] {
			t.Fatal(got)
		}
	}
}
