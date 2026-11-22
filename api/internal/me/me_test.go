package me_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"testing"

	"streamiq/api/internal/apitest"
	"streamiq/api/internal/auth"
	"streamiq/api/internal/me"
)

func TestMain(m *testing.M) { os.Exit(apitest.Run(m)) }

// getMe is GET /api/me as a generic JSON value, so the test sees the wire shape.
func getMe(t *testing.T, base, token string) map[string]any {
	t.Helper()
	rq, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, base+"/api/me", nil)
	rq.Header.Set("Authorization", "Bearer "+token)
	rs, err := http.DefaultClient.Do(rq)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rs.Body.Close() }()
	if rs.StatusCode != http.StatusOK || rs.Header.Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("%s, %s", rs.Status, rs.Header.Get("Content-Type"))
	}
	var v map[string]any
	if err := json.NewDecoder(rs.Body).Decode(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

// The response: userId, tenantId (null without a
// household) and memberships oldest first, each {id, name, role}.
func TestMe(t *testing.T) {
	apitest.Reset(t)
	v, err := auth.NewVerifier(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	me.Routes(mux, auth.New(v, apitest.DB))
	ts := httptest.NewServer(mux)
	defer ts.Close()
	token := apitest.Token(t, "me@home.test")

	first := getMe(t, ts.URL, token)
	user, _ := first["userId"].(string)
	if want := map[string]any{
		"userId":      user,
		"tenantId":    nil,
		"memberships": []any{},
	}; user == "" ||
		!reflect.DeepEqual(first, want) {
		t.Fatalf("no household: %v", first)
	}

	home := apitest.Household(t, user, "admin")
	cabin := apitest.Household(t, user, "member")
	apitest.Exec(t, `UPDATE tenants SET name = NULL WHERE id = $1`, cabin)
	want := map[string]any{"userId": user, "tenantId": home, "memberships": []any{
		map[string]any{"id": home, "name": "home", "role": "admin"},
		map[string]any{"id": cabin, "name": nil, "role": "member"},
	}}
	if got := getMe(t, ts.URL, token); !reflect.DeepEqual(got, want) {
		t.Fatalf("two households:\n got %v\nwant %v", got, want)
	}
}
