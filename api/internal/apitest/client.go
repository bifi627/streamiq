package apitest

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	fbauth "firebase.google.com/go/v4/auth"

	"streamiq/api/internal/auth"
)

// Server serves the routes routes adds, through a real Auth on DB, for this test.
func Server(t *testing.T, routes func(*http.ServeMux, *auth.Auth)) *Client {
	t.Helper()
	v, err := auth.NewVerifier(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	a := auth.New(v, DB)
	mux := http.NewServeMux()
	routes(mux, a)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return &Client{URL: ts.URL, Auth: a}
}

type Client struct {
	URL  string
	Auth *auth.Auth
}

// Answer is a response, its body read.
type Answer struct {
	Status int
	Header http.Header
	Body   []byte
}

// JSON decodes the body into a new T.
func JSON[T any](t *testing.T, a Answer) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(a.Body, &v); err != nil {
		t.Fatalf("%d %s: %v", a.Status, a.Body, err)
	}
	return v
}

// Do sends method path as token's user ("" = signed out), acting in household ("" =
// none named), with body as its JSON ("" = none) and header's pairs. A request that
// fails is a test error and a zero Answer: Do also runs off the test's goroutine.
func (c *Client) Do(t *testing.T, method, path, token, household, body string, header ...string) Answer {
	t.Helper()
	rq, _ := http.NewRequestWithContext(t.Context(), method, c.URL+path, strings.NewReader(body))
	if token != "" {
		rq.Header.Set("Authorization", "Bearer "+token)
	}
	if household != "" {
		rq.Header.Set(auth.HouseholdHeader, household)
	}
	for i := 0; i+1 < len(header); i += 2 {
		rq.Header.Set(header[i], header[i+1])
	}
	rs, err := http.DefaultClient.Do(rq)
	if err != nil {
		t.Error(err)
		return Answer{}
	}
	defer func() { _ = rs.Body.Close() }()
	b, _ := io.ReadAll(rs.Body)
	return Answer{rs.StatusCode, rs.Header, bytes.TrimSpace(b)}
}

// User is token's users.id (adding the user on first use).
func (c *Client) User(t *testing.T, token string) string {
	t.Helper()
	caller, err := c.Auth.Token(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	return caller.User
}

// Alias sets the Firebase display name of token's account. The emulator keeps it for
// the whole run, across packages: give such an account an email no other test uses.
func Alias(t *testing.T, token, alias string) {
	t.Helper()
	v, err := auth.NewVerifier(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	id, err := v.VerifyIDToken(t.Context(), token)
	if err == nil {
		_, err = v.UpdateUser(t.Context(), id.UID, (&fbauth.UserToUpdate{}).DisplayName(alias))
	}
	if err != nil {
		t.Fatal(err)
	}
}

// GoogleToken is an ID token from a Google sign-in through the emulator's signInWithIdp,
// which takes the Google id_token as plain JSON claims (what its fake popup sends).
func GoogleToken(t *testing.T, sub, email string) string {
	t.Helper()
	claims, _ := json.Marshal(map[string]any{"sub": sub, "email": email, "email_verified": true,
		"name": "G User", "picture": "https://x.test/p.png"})
	body, _ := json.Marshal(map[string]any{"requestUri": "http://localhost", "returnSecureToken": true,
		"postBody": "id_token=" + url.QueryEscape(string(claims)) + "&providerId=google.com"})
	rs, err := http.Post(
		"http://"+Emulator+"/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=fake-api-key",
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rs.Body.Close() }()
	var out struct{ IDToken string }
	if err := json.NewDecoder(rs.Body).Decode(&out); err != nil || out.IDToken == "" {
		t.Fatalf("signInWithIdp: %d %v", rs.StatusCode, err)
	}
	return out.IDToken
}
