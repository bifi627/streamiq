package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgxpool"

	"streamiq/backend/api"
	"streamiq/backend/migrations"
)

// One Postgres and one Firebase Auth emulator for the package, started with the docker
// CLI (no testcontainers dependency). The server runs in-process (httptest), connected
// as streamiq_app; owner is the tables' owner and only arranges state the ported slices
// can't (households, memberships, gateways).
var (
	owner    *pgxpool.Pool
	srv      *Server
	base     string // http://127.0.0.1:port
	emulator string // host:port
	appURL   string
)

func TestMain(m *testing.M) { os.Exit(run(m)) }

func run(m *testing.M) int {
	ctx := context.Background()
	repo, _ := filepath.Abs("../../..")
	fbDir := filepath.Join(repo, "dev", "firebase")
	dockerfile, _ := os.ReadFile(filepath.Join(fbDir, "Dockerfile"))
	config, _ := os.ReadFile(filepath.Join(fbDir, "firebase.json"))
	sum := sha256.Sum256(append(dockerfile, config...))
	image := "streamiq-firebase-emulator:" + hex.EncodeToString(sum[:])[:12] // the tag the .NET tests and e2e use
	docker("build", "-q", "-t", image, fbDir)

	pg := docker("run", "-d", "--rm", "-e", "POSTGRES_PASSWORD=dev", "--tmpfs", "/var/lib/postgresql", "-p", "127.0.0.1::5432", "postgres:18")
	defer docker("rm", "-f", pg)
	fb := docker("run", "-d", "--rm", "-p", "127.0.0.1::9099", "-w", "/app",
		"--mount", "type=bind,source="+filepath.Join(fbDir, "firebase.json")+",target=/app/firebase.json,readonly",
		image, "firebase", "emulators:start", "--only", "auth", "--project", "demo-streamiq")
	defer docker("rm", "-f", fb)
	emulator = docker("port", fb, "9099/tcp")
	pgAddr := docker("port", pg, "5432/tcp")
	ownerURL := "postgres://postgres:dev@" + pgAddr + "/postgres"
	appURL = "postgres://streamiq_app:app@" + pgAddr + "/postgres"

	must(eventually(60*time.Second, func() error { return migrations.Up(ctx, ownerURL) }))
	var err error
	owner, err = pgxpool.New(ctx, ownerURL)
	must(err)
	_, err = owner.Exec(ctx, `ALTER ROLE streamiq_app LOGIN PASSWORD 'app'`)
	must(err)
	must(eventually(90*time.Second, func() error {
		rs, err := http.Get("http://" + emulator)
		if err == nil {
			rs.Body.Close()
		}
		return err
	}))

	os.Setenv("FIREBASE_AUTH_EMULATOR_HOST", emulator)
	os.Setenv("FIREBASE_PROJECT_ID", "demo-streamiq")
	os.Setenv("STREAMIQ_ENV", "development")
	verifier, err := NewVerifier(ctx)
	must(err)
	db, err := OpenDB(ctx, appURL)
	must(err)
	srv = New(db, verifier, Config{AuthTimeout: 500 * time.Millisecond})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	base = ts.URL
	return m.Run()
}

func docker(args ...string) string {
	out, err := exec.Command("docker", args...).Output()
	if err != nil {
		panic(fmt.Sprintf("docker %v: %v", args, err))
	}
	return strings.TrimSpace(strings.Split(string(out), "\n")[0])
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func eventually(limit time.Duration, f func() error) (err error) {
	for end := time.Now().Add(limit); time.Now().Before(end); time.Sleep(250 * time.Millisecond) {
		if err = f(); err == nil {
			return nil
		}
	}
	return err
}

// reset empties the database before a test (the emulator keeps its accounts).
func reset(t *testing.T) {
	t.Helper()
	exec1(t, `TRUNCATE gateways, users, tenants CASCADE`)
}

func exec1(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := owner.Exec(context.Background(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

func scalar[T any](t *testing.T, sql string, args ...any) (v T) {
	t.Helper()
	if err := owner.QueryRow(context.Background(), sql, args...).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

// mint gets a real ID token from the emulator's Identity Toolkit API: it goes through
// the same VerifyIDToken as a production token.
func mint(t *testing.T, email string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"email": email, "password": "password123", "returnSecureToken": true})
	for _, op := range []string{"signUp", "signInWithPassword"} { // the second: an account an earlier test made
		rs, err := http.Post("http://"+emulator+"/identitytoolkit.googleapis.com/v1/accounts:"+op+"?key=fake-api-key", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		var out struct{ IDToken string }
		_ = json.NewDecoder(rs.Body).Decode(&out)
		rs.Body.Close()
		if out.IDToken != "" {
			return out.IDToken
		}
	}
	t.Fatalf("no ID token for %s", email)
	return ""
}

func request(t *testing.T, method, path, token string, body any, headers ...string) *http.Response {
	t.Helper()
	b, _ := json.Marshal(body)
	rq, _ := http.NewRequest(method, base+path, bytes.NewReader(b))
	if token != "" {
		rq.Header.Set("Authorization", "Bearer "+token)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		rq.Header.Set(headers[i], headers[i+1])
	}
	rs, err := http.DefaultClient.Do(rq)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { rs.Body.Close() })
	return rs
}

func decode[T any](t *testing.T, rs *http.Response) (v T) {
	t.Helper()
	b, _ := io.ReadAll(rs.Body)
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("%s: %s", rs.Status, b)
	}
	return v
}

// user is a signed-in person; household is "" until they own or join one.
type user struct{ token, id, household string }

// signIn provisions the user through the API (GET /api/me), like a first visit.
func signIn(t *testing.T, email string) *user {
	t.Helper()
	u := &user{token: mint(t, email)}
	u.id = decode[api.Me](t, request(t, "GET", "/api/me", u.token, nil)).UserID
	return u
}

// owning signs the user in as the admin of a new household of their own.
func owning(t *testing.T, email string) *user {
	t.Helper()
	u := signIn(t, email)
	u.household = scalar[string](t, `INSERT INTO tenants ("Id") VALUES (uuidv7()) RETURNING "Id"`)
	join(t, u, u.household, "admin")
	return u
}

func join(t *testing.T, u *user, household, role string) {
	t.Helper()
	exec1(t, `INSERT INTO memberships ("TenantId", "UserId", "Role") VALUES ($1, $2, $3)`, household, u.id, role)
}

// client is a test's end of a socket: a pump reads it into msgs, so a test can wait
// for a message, or for none, without cancelling a read (which would drop the socket).
type client struct {
	t      *testing.T
	conn   *websocket.Conn
	msgs   chan map[string]any
	closed chan websocket.CloseError
}

func dial(t *testing.T, path string, headers ...string) (*client, *http.Response, error) {
	t.Helper()
	h := http.Header{}
	for i := 0; i+1 < len(headers); i += 2 {
		h.Set(headers[i], headers[i+1])
	}
	conn, rs, err := websocket.Dial(context.Background(), base+path, &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		return nil, rs, err
	}
	conn.SetReadLimit(-1)
	c := &client{t, conn, make(chan map[string]any, 64), make(chan websocket.CloseError, 1)}
	t.Cleanup(func() { _ = conn.CloseNow() })
	go func() {
		for {
			_, b, err := conn.Read(context.Background())
			if err != nil {
				var ce websocket.CloseError
				_ = errors.As(err, &ce)
				c.closed <- ce
				return
			}
			var m map[string]any
			_ = json.Unmarshal(b, &m)
			c.msgs <- m
		}
	}()
	return c, rs, nil
}

func (c *client) send(v any) {
	c.t.Helper()
	b, ok := v.([]byte)
	if !ok {
		b, _ = json.Marshal(v)
	}
	if err := c.conn.Write(context.Background(), websocket.MessageText, b); err != nil {
		c.t.Fatalf("send: %v", err)
	}
}

// next is the next message, which must be of the given type.
func (c *client) next(typ string) map[string]any {
	c.t.Helper()
	select {
	case m := <-c.msgs:
		if m["type"] != typ {
			c.t.Fatalf("got %v, want a %q", m, typ)
		}
		return m
	case ce := <-c.closed:
		c.t.Fatalf("socket closed (%q) waiting for a %q", ce.Reason, typ)
	case <-time.After(5 * time.Second):
		c.t.Fatalf("no %q within 5 s", typ)
	}
	return nil
}

func (c *client) nothing() {
	c.t.Helper()
	select {
	case m := <-c.msgs:
		c.t.Fatalf("got %v, want nothing", m)
	case <-time.After(300 * time.Millisecond):
	}
}

// closedAs waits for the server to close the socket and returns the reason.
func (c *client) closedAs() string {
	c.t.Helper()
	select {
	case ce := <-c.closed:
		return ce.Reason
	case <-time.After(5 * time.Second):
		c.t.Fatal("socket not closed within 5 s")
	}
	return ""
}

// gateway is an enrolled gateway and, once online, its control socket.
type gateway struct {
	*client
	id, credential string
}

func heartbeat() map[string]any {
	return map[string]any{"type": "heartbeat", "protocol": 1, "name": "nas", "version": "1.0.0", "lanUrl": "http://192.168.1.20:8097", "telemetry": "off"}
}

// onlineGateway enrolls a gateway in u's household and connects it with a first heartbeat.
func onlineGateway(t *testing.T, u *user, name string) *gateway {
	t.Helper()
	g := &gateway{credential: "cred-" + newUUID()}
	g.id = scalar[string](t, `INSERT INTO gateways ("Id", "TenantId", "Name", "CredentialHash") VALUES (uuidv7(), $1, $2, $3) RETURNING "Id"`,
		u.household, name, hashSecret(g.credential))
	c, _, err := dial(t, "/api/gateways/ws", "Authorization", "Bearer "+g.credential)
	if err != nil {
		t.Fatal(err)
	}
	g.client = c
	g.send(heartbeat())
	if eventually(5*time.Second, func() error {
		if srv.broker.gateway(g.id) == nil {
			return fmt.Errorf("gateway %s not registered", name)
		}
		return nil
	}) != nil {
		t.Fatalf("gateway %s never came online", name)
	}
	return g
}

// browser opens an authenticated broker socket and reads its `ready`.
func browser(t *testing.T, u *user, headers ...string) *client {
	t.Helper()
	c, _, err := dial(t, "/api/broker/ws", headers...)
	if err != nil {
		t.Fatal(err)
	}
	c.send(map[string]any{"type": "auth", "token": u.token})
	c.next("ready")
	return c
}

var sdp = map[string]any{"type": "offer", "sdp": "v=0\r\n"}

func offerTo(c *client, g *gateway) {
	c.send(map[string]any{"type": "offer", "gatewayId": g.id, "sdp": sdp})
}
