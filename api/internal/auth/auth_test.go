package auth_test

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"streamiq/api/internal/apitest"
	"streamiq/api/internal/auth"
)

func TestMain(m *testing.M) { os.Exit(apitest.Run(m)) }

// server serves the Caller as JSON at /required and /optional (no household needed).
func server(t *testing.T) string {
	t.Helper()
	v, err := auth.NewVerifier(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	a := auth.New(v, apitest.DB)
	echo := func(w http.ResponseWriter, _ *http.Request, c auth.Caller) { _ = json.NewEncoder(w).Encode(c) }
	mux := http.NewServeMux()
	mux.HandleFunc("/required", a.Handler(false, echo))
	mux.HandleFunc("/optional", a.Handler(true, echo))
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts.URL
}

func get(t *testing.T, url, token string, headers ...string) (*http.Response, auth.Caller) {
	t.Helper()
	rq, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
	if token != "" {
		rq.Header.Set("Authorization", "Bearer "+token)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		rq.Header.Add(headers[i], headers[i+1])
	}
	rs, err := http.DefaultClient.Do(rq)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rs.Body.Close() }()
	var c auth.Caller
	if rs.StatusCode == http.StatusOK {
		if err := json.NewDecoder(rs.Body).Decode(&c); err != nil {
			t.Fatal(err)
		}
	}
	return rs, c
}

func TestRejectedTokensGet401AndNoUser(t *testing.T) {
	apitest.Reset(t)
	base := server(t)
	// What the emulator issues, alg none and no signature, so only the claims decide.
	unsigned := func(claims string) string {
		enc := base64.RawURLEncoding.EncodeToString
		return enc([]byte(`{"alg":"none","typ":"JWT"}`)) + "." + enc([]byte(claims)) + "."
	}
	for name, token := range map[string]string{
		"no token":        "",
		"garbage":         "garbage",
		"expired":         unsigned(`{"iss":"https://securetoken.google.com/demo-streamiq","aud":"demo-streamiq","sub":"u1","iat":1,"exp":2}`),
		"another project": unsigned(`{"iss":"https://securetoken.google.com/other","aud":"other","sub":"u1","iat":1,"exp":9999999999}`),
	} {
		t.Run(name, func(t *testing.T) {
			if rs, _ := get(t, base+"/optional", token); rs.StatusCode != http.StatusUnauthorized {
				t.Fatalf("status %d, want 401", rs.StatusCode)
			}
		})
	}
	if n := apitest.Scalar[int](t, `SELECT count(*) FROM users`); n != 0 {
		t.Fatalf("rejected tokens added %d users", n)
	}
}

func TestConcurrentFirstSignInsAddOneUser(t *testing.T) {
	apitest.Reset(t)
	base := server(t)
	token := apitest.Token(t, "fresh@home.test")
	ids := make([]string, 20)
	var wg sync.WaitGroup
	for i := range ids {
		wg.Go(func() {
			rs, c := get(t, base+"/optional", token)
			if rs.StatusCode == http.StatusOK && c.Tenant == "" {
				ids[i] = c.User
			}
		})
	}
	wg.Wait()
	for _, id := range ids {
		if id == "" || id != ids[0] {
			t.Fatalf("20 first requests gave user ids %v", ids)
		}
	}
	if users, tenants := apitest.Scalar[int](
		t,
		`SELECT count(*) FROM users`,
	), apitest.Scalar[int](
		t,
		`SELECT count(*) FROM tenants`,
	); users != 1 ||
		tenants != 0 {
		t.Fatalf("%d users and %d households, want 1 and 0", users, tenants)
	}
}

func TestTheHouseholdComesOnlyFromTheUsersMemberships(t *testing.T) {
	apitest.Reset(t)
	base := server(t)
	alice, bob := apitest.Token(t, "alice@home.test"), apitest.Token(t, "bob@home.test")
	_, a := get(t, base+"/optional", alice)
	_, b := get(t, base+"/optional", bob)
	oldest := apitest.Household(t, a.User, "admin")
	second := apitest.Household(t, a.User, "member")
	bobs := apitest.Household(t, b.User, "admin")

	t.Run("none named: the oldest", func(t *testing.T) {
		if _, c := get(t, base+"/required", alice); c.Tenant != oldest || c.Role != "admin" || len(c.Households) != 2 {
			t.Fatalf("got %+v, want %s as admin of 2", c, oldest)
		}
	})
	t.Run("named: that one, in any case", func(t *testing.T) {
		if _, c := get(
			t,
			base+"/required",
			alice,
			auth.HouseholdHeader,
			strings.ToUpper(second),
		); c.Tenant != second ||
			c.Role != "member" {
			t.Fatalf("got %+v, want %s as member", c, second)
		}
	})
	notMember := map[string][]string{
		"another user's":    {bobs},
		"one that's gone":   {"018f0000-0000-7000-8000-000000000000"},
		"a malformed id":    {"not-a-uuid"},
		"an empty header":   {""},
		"two of the user's": {oldest, second},
	}
	for name, values := range notMember {
		t.Run(name+" is the not-a-member 404", func(t *testing.T) {
			var headers []string
			for _, v := range values {
				headers = append(headers, auth.HouseholdHeader, v)
			}
			for _, path := range []string{"/required", "/optional"} {
				rs, _ := get(t, base+path, alice, headers...)
				if rs.StatusCode != http.StatusNotFound || rs.Header.Get(auth.NotMemberHeader) != "1" {
					t.Fatalf(
						"%s: %d, %s=%q",
						path,
						rs.StatusCode,
						auth.NotMemberHeader,
						rs.Header.Get(auth.NotMemberHeader),
					)
				}
			}
		})
	}
	t.Run("no household: optional only", func(t *testing.T) {
		carol := apitest.Token(t, "carol@home.test")
		if rs, _ := get(
			t,
			base+"/required",
			carol,
		); rs.StatusCode != http.StatusNotFound ||
			rs.Header.Get(auth.NotMemberHeader) != "1" {
			t.Fatalf("required: %d", rs.StatusCode)
		}
		if rs, c := get(
			t,
			base+"/optional",
			carol,
		); rs.StatusCode != http.StatusOK || c.Tenant != "" ||
			len(c.Households) != 0 {
			t.Fatalf("optional: %d %+v", rs.StatusCode, c)
		}
	})
}

func TestTheEmulatorNeedsDevelopment(t *testing.T) {
	for _, env := range []string{"", "production", "Development"} {
		t.Setenv("STREAMIQ_ENV", env)
		if _, err := auth.NewVerifier(t.Context()); err == nil {
			t.Fatalf("STREAMIQ_ENV=%q: the API starts against the emulator", env)
		}
	}
	t.Setenv("STREAMIQ_ENV", "development")
	if _, err := auth.NewVerifier(t.Context()); err != nil {
		t.Fatal(err)
	}
}

// Without the emulator, production refuses to start on a config that would reject
// every real login, or accept tokens for the wrong project.
func TestProductionRefusesAFirebaseConfigWithoutAProject(t *testing.T) {
	t.Setenv("FIREBASE_AUTH_EMULATOR_HOST", "")
	t.Setenv("STREAMIQ_ENV", "")
	for name, c := range map[string]struct{ project, serviceAccount, want string }{
		"no project":         {"", `{"type":"service_account"}`, "FIREBASE_PROJECT_ID is not set"},
		"a demo project":     {"demo-streamiq", `{"type":"service_account"}`, "a demo project"},
		"no service account": {"streamiq-prod", " ", "FIREBASE_SERVICE_ACCOUNT_JSON is empty"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("FIREBASE_PROJECT_ID", c.project)
			t.Setenv("FIREBASE_SERVICE_ACCOUNT_JSON", c.serviceAccount)
			if _, err := auth.NewVerifier(t.Context()); err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("got %v, want %q", err, c.want)
			}
		})
	}
}

// A Google sign-in for an email signed up by password is the same user (Firebase: one
// account per email), again on the next sign-in, and none of its profile claims is
// stored (the users row has no column for them).
func TestAGoogleSignInIsOneUserAlsoWithAPasswordForItsEmail(t *testing.T) {
	apitest.Reset(t)
	base := server(t)
	email := "google-" + strings.ToLower(rand.Text()[:8]) + "@home.test"
	_, password := get(t, base+"/optional", apitest.Token(t, email))
	google := apitest.GoogleToken(t, "g-"+rand.Text(), email)
	_, first := get(t, base+"/optional", google)
	_, again := get(t, base+"/optional", google)
	if password.User == "" || first.User != password.User || again.User != password.User {
		t.Fatalf("users %q, %q, %q; want one", password.User, first.User, again.User)
	}
	if users, tenants := apitest.Scalar[int](t, `SELECT count(*) FROM users`),
		apitest.Scalar[int](t, `SELECT count(*) FROM tenants`); users != 1 || tenants != 0 {
		t.Fatalf("%d users and %d households, want 1 and 0", users, tenants)
	}
}
