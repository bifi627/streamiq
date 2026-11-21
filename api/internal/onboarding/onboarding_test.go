package onboarding_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"streamiq/api/internal/apitest"
	"streamiq/api/internal/auth"
	"streamiq/api/internal/iplimit"
	"streamiq/api/internal/onboarding"
)

func TestMain(m *testing.M) { os.Exit(apitest.Run(m)) }

const fingerprint = "sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"

type server struct {
	url string
	a   *auth.Auth
}

func newServer(t *testing.T, in onboarding.Install, ips *iplimit.Limiter) *server {
	t.Helper()
	apitest.Reset(t)
	v, err := auth.NewVerifier(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	a := auth.New(v, apitest.DB)
	mux := http.NewServeMux()
	onboarding.Routes(mux, a, apitest.DB, ips, in)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return &server{ts.URL, a}
}

func newDefault(t *testing.T) *server {
	return newServer(t, onboarding.Install{Dev: true}, iplimit.New(1000, ""))
}

// member is email's token, a member with role of a household of its own.
func (s *server) member(t *testing.T, email, role string) (token, household string) {
	t.Helper()
	token = apitest.Token(t, email)
	c, err := s.a.Token(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	return token, apitest.Household(t, c.User, role)
}

// post is POST path with body, as token when set; header is extra request headers.
func (s *server) post(t *testing.T, path, token, body string, header http.Header) (int, []byte) {
	t.Helper()
	rq, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, s.url+path, strings.NewReader(body))
	for k, v := range header {
		rq.Header[k] = v
	}
	if token != "" {
		rq.Header.Set("Authorization", "Bearer "+token)
	}
	rs, err := http.DefaultClient.Do(rq)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rs.Body.Close() }()
	b, _ := io.ReadAll(rs.Body)
	return rs.StatusCode, bytes.TrimSpace(b)
}

func (s *server) token(t *testing.T, admin string) onboarding.EnrollmentToken {
	t.Helper()
	status, body := s.post(t, "/api/gateways/enrollment-tokens", admin, "", nil)
	var out onboarding.EnrollmentToken
	if err := json.Unmarshal(body, &out); status != http.StatusOK || err != nil {
		t.Fatal(status, string(body))
	}
	return out
}

func (s *server) enroll(t *testing.T, token, name string) (int, onboarding.Enrolled) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"token": token, "fingerprint": fingerprint, "name": name})
	status, b := s.post(t, "/api/gateways/enroll", "", string(body), nil)
	var out onboarding.Enrolled
	if status == http.StatusOK {
		if err := json.Unmarshal(b, &out); err != nil {
			t.Fatal(string(b))
		}
	}
	return status, out
}

func sha(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func TestAnAdminMintsAToken128BitFor15MinutesStoredOnlyAsItsHash(t *testing.T) {
	s := newDefault(t)
	alice, home := s.member(t, "alice@home.test", "admin")
	tok := s.token(t, alice)
	if len(tok.Token) != 22 || time.Until(tok.ExpiresAt) > 15*time.Minute || time.Until(tok.ExpiresAt) < 14*time.Minute {
		t.Fatal(tok)
	}
	row := apitest.Scalar[string](t, `SELECT concat_ws('|', "TenantId", "TokenHash", "UsedAt") FROM enrollment_tokens`)
	if row != home+"|"+sha(tok.Token) {
		t.Fatal(row)
	}
}

func TestAMemberCannotMintATokenNorCanAnyoneSignedOut(t *testing.T) {
	s := newDefault(t)
	bob, _ := s.member(t, "bob@home.test", "member")
	if status, _ := s.post(t, "/api/gateways/enrollment-tokens", bob, "", nil); status != http.StatusForbidden {
		t.Fatal(status)
	}
	if status, _ := s.post(t, "/api/gateways/enrollment-tokens", "", "", nil); status != http.StatusUnauthorized {
		t.Fatal(status)
	}
	if n := apitest.Scalar[int](t, `SELECT count(*) FROM enrollment_tokens`); n != 0 {
		t.Fatal(n)
	}
}

func TestTheInstallCommandsCarryTheTokenAndTheAPIURL(t *testing.T) {
	const rel = "https://github.com/bifi627/streamiq/releases/latest/download"
	for _, c := range []struct {
		name   string
		in     onboarding.Install
		header http.Header
		api    func(s *server) string
		sh, ps string
	}{
		{"dev, the request's URL", onboarding.Install{Dev: true}, nil, func(s *server) string { return s.url },
			"STREAMIQ_API_URL={api} STREAMIQ_ENROLL_TOKEN={tok} go run ./cmd/gateway",
			"$env:STREAMIQ_API_URL='{api}'; $env:STREAMIQ_ENROLL_TOKEN='{tok}'; go run ./cmd/gateway"},
		{"release, the public URL", onboarding.Install{PublicURL: "https://streamiq.example/"}, nil,
			func(*server) string { return "https://streamiq.example" },
			"curl -fsSL " + rel + "/install.sh | STREAMIQ_API_URL={api} STREAMIQ_ENROLL_TOKEN={tok} sh",
			"$env:STREAMIQ_API_URL='{api}'; $env:STREAMIQ_ENROLL_TOKEN='{tok}'; irm " + rel + "/install.ps1 | iex"},
		{"behind a TLS proxy", onboarding.Install{Dev: true}, http.Header{"X-Forwarded-Proto": {"https"}},
			func(s *server) string { return "https://" + strings.TrimPrefix(s.url, "http://") },
			"STREAMIQ_API_URL={api} STREAMIQ_ENROLL_TOKEN={tok} go run ./cmd/gateway",
			"$env:STREAMIQ_API_URL='{api}'; $env:STREAMIQ_ENROLL_TOKEN='{tok}'; go run ./cmd/gateway"},
	} {
		t.Run(c.name, func(t *testing.T) {
			s := newServer(t, c.in, iplimit.New(1000, ""))
			alice, _ := s.member(t, "alice@home.test", "admin")
			_, body := s.post(t, "/api/gateways/enrollment-tokens", alice, "", c.header)
			var tok onboarding.EnrollmentToken
			_ = json.Unmarshal(body, &tok)
			r := strings.NewReplacer("{api}", c.api(s), "{tok}", tok.Token)
			if tok.InstallCommand != r.Replace(c.sh) || tok.InstallCommandPowershell != r.Replace(c.ps) {
				t.Fatalf("%s\n%s", tok.InstallCommand, tok.InstallCommandPowershell)
			}
		})
	}
}

// Onboarding.feature: an enrollment token works exactly once; the credential is 256 bit,
// stored only as its hash; the gateway lands in the token's household only.
func TestATokenEnrollsOneGatewayIntoItsOwnHouseholdOnce(t *testing.T) {
	s := newDefault(t)
	alice, home := s.member(t, "alice@home.test", "admin")
	eve, cabin := s.member(t, "eve@home.test", "admin")
	tok, other := s.token(t, alice), s.token(t, eve)
	status, g := s.enroll(t, tok.Token, "nas")
	if status != http.StatusOK || len(g.Credential) != 43 {
		t.Fatal(status, g)
	}
	row := apitest.Scalar[string](t, `SELECT concat_ws('|', "TenantId", "Name", "DtlsFingerprint", "CredentialHash")
		FROM gateways WHERE "Id" = $1`, g.GatewayID)
	if row != home+"|nas|"+fingerprint+"|"+sha(g.Credential) {
		t.Fatal(row)
	}
	if status, _ := s.enroll(t, tok.Token, "again"); status != http.StatusUnauthorized {
		t.Fatal(status)
	}
	_, g2 := s.enroll(t, other.Token, "")
	if got := apitest.Scalar[string](t, `SELECT "TenantId"::text || '|' || "Name" FROM gateways WHERE "Id" = $1`,
		g2.GatewayID); got != cabin+"|gateway" {
		t.Fatal(got)
	}
	if n := apitest.Scalar[int](t, `SELECT count(*) FROM gateways`); n != 2 {
		t.Fatal(n)
	}
}

// Onboarding.feature: an expired enrollment token is rejected; so is an unknown one.
func TestAnExpiredOrUnknownTokenIsRejected(t *testing.T) {
	s := newDefault(t)
	alice, _ := s.member(t, "alice@home.test", "admin")
	tok := s.token(t, alice)
	apitest.Exec(t, `UPDATE enrollment_tokens SET "ExpiresAt" = now() - interval '1 second'`)
	for _, token := range []string{tok.Token, "unknown"} {
		if status, _ := s.enroll(t, token, "nas"); status != http.StatusUnauthorized {
			t.Fatal(token, status)
		}
	}
	if n := apitest.Scalar[int](t, `SELECT count(*) FROM gateways`); n != 0 {
		t.Fatal(n)
	}
}

func TestABadEnrollmentIsA400(t *testing.T) {
	s := newDefault(t)
	for _, body := range []string{
		``, `{`, `{}`, `null`,
		`{"token":"","fingerprint":"` + fingerprint + `"}`,
		`{"token":"t"}`,
		`{"token":"t","fingerprint":"` + strings.ToLower(fingerprint) + `"}`,
		`{"token":"t","fingerprint":"sha-1 AA:BB"}`,
	} {
		if status, _ := s.post(t, "/api/gateways/enroll", "", body, nil); status != http.StatusBadRequest {
			t.Fatal(body, status)
		}
	}
}

func TestTheNameIsCutTo100UTF16Units(t *testing.T) {
	s := newDefault(t)
	alice, _ := s.member(t, "alice@home.test", "admin")
	for _, c := range []struct{ sent, want string }{
		{strings.Repeat("ä", 150), strings.Repeat("ä", 100)},
		{"a" + strings.Repeat("😀", 60), "a" + strings.Repeat("😀", 49)}, // an emoji counts 2, never split
	} {
		_, g := s.enroll(t, s.token(t, alice).Token, c.sent)
		if n := apitest.Scalar[string](t, `SELECT "Name" FROM gateways WHERE "Id" = $1`, g.GatewayID); n != c.want {
			t.Fatal(n)
		}
	}
}

func TestOneTokenEnrollingTwiceAtOnceMakesOneGateway(t *testing.T) {
	s := newDefault(t)
	alice, _ := s.member(t, "alice@home.test", "admin")
	tok := s.token(t, alice)
	const n = 8
	statuses := make([]int, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Go(func() { statuses[i], _ = s.enroll(t, tok.Token, "nas") })
	}
	wg.Wait()
	ok := 0
	for _, st := range statuses {
		if st == http.StatusOK {
			ok++
		} else if st != http.StatusUnauthorized {
			t.Fatal(statuses)
		}
	}
	if gateways := apitest.Scalar[int](t, `SELECT count(*) FROM gateways`); ok != 1 || gateways != 1 {
		t.Fatal(statuses, gateways)
	}
}

func TestAnEnrollmentThatFailsAfterTheClaimKeepsTheToken(t *testing.T) {
	s := newDefault(t)
	alice, _ := s.member(t, "alice@home.test", "admin")
	tok := s.token(t, alice)
	apitest.Exec(t, `CREATE FUNCTION fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE 'no'; END $$;
		CREATE TRIGGER fail BEFORE INSERT ON gateways FOR EACH ROW EXECUTE FUNCTION fail()`)
	t.Cleanup(func() {
		_, _ = apitest.Owner.Exec(context.Background(), `DROP TRIGGER IF EXISTS fail ON gateways; DROP FUNCTION fail()`)
	})
	if status, _ := s.enroll(t, tok.Token, "nas"); status != http.StatusInternalServerError {
		t.Fatal(status)
	}
	apitest.Exec(t, `DROP TRIGGER fail ON gateways`)
	if status, _ := s.enroll(t, tok.Token, "nas"); status != http.StatusOK {
		t.Fatal(status)
	}
}

// RateLimitTests: enrollment and enrollment tokens spend the client IP's one budget.
func TestEnrollmentAndTokensAreLimitedPerClientIP(t *testing.T) {
	s := newServer(t, onboarding.Install{Dev: true}, iplimit.New(3, "X-Real-IP"))
	alice, _ := s.member(t, "alice@home.test", "admin")
	ip := func(v string) http.Header { return http.Header{"X-Real-IP": {v}} }
	enroll := func(v string) int {
		status, _ := s.post(t, "/api/gateways/enroll", "", `{}`, ip(v))
		return status
	}
	token, _ := s.post(t, "/api/gateways/enrollment-tokens", alice, "", ip("203.0.113.1"))
	got := []int{
		token, enroll("203.0.113.1"), enroll("203.0.113.1"), enroll("203.0.113.1"),
		enroll("203.0.113.2"),
	}
	if got[0] != 200 || got[1] != 400 || got[2] != 400 || got[3] != 429 || got[4] != 400 {
		t.Fatal(got) // another IP has its own budget
	}
	if status, _ := s.post(t, "/api/gateways/enrollment-tokens", alice, "", ip("203.0.113.1")); status != 429 {
		t.Fatal(status)
	}
}
