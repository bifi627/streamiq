// Package apitest is the API's test fixture: a Postgres and a Firebase Auth emulator,
// a database of its own per test package, and ID tokens from the emulator.
//
// scripts/test-api.sh starts one pair for the whole run and passes it in
// STREAMIQ_TEST_POSTGRES (a superuser URL, any database) and STREAMIQ_TEST_FIREBASE
// (host:port). Without them, a package starts its own pair with the docker CLI.
package apitest

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"streamiq/api/internal/db"
)

// AppPassword is streamiq_app's password in tests.
const AppPassword = "app"

var (
	// Postgres is the superuser URL of the server, Emulator the emulator's host:port.
	Postgres, Emulator string
	// OwnerURL reaches this package's database as its owner.
	OwnerURL string
	// Owner arranges state as the tables' owner, past every policy.
	Owner *pgxpool.Pool
	// DB is the API's own: migrated, connected as streamiq_app.
	DB *db.DB
)

// Run is a TestMain: os.Exit(apitest.Run(m)).
func Run(m *testing.M) int {
	ctx := context.Background()
	Postgres, Emulator = os.Getenv("STREAMIQ_TEST_POSTGRES"), os.Getenv("STREAMIQ_TEST_FIREBASE")
	if Postgres == "" || Emulator == "" {
		stop := startPair()
		defer stop()
	}
	name := "test_" + strings.ToLower(rand.Text()[:10])
	must(eventually(90*time.Second, func() error { return exec1(ctx, Postgres, `CREATE DATABASE `+name) }))
	OwnerURL = withDB(Postgres, name)
	var err error
	DB, err = open(ctx)
	must(err)
	defer DB.Close()
	Owner, err = pgxpool.New(ctx, OwnerURL)
	must(err)
	defer Owner.Close()
	must(eventually(90*time.Second, func() error {
		rs, err := http.Get("http://" + Emulator)
		if err == nil {
			_ = rs.Body.Close()
		}
		return err
	}))
	must(os.Setenv("FIREBASE_AUTH_EMULATOR_HOST", Emulator))
	must(os.Setenv("FIREBASE_PROJECT_ID", "demo-streamiq"))
	must(os.Setenv("STREAMIQ_ENV", "development"))
	return m.Run()
}

// open is db.Open, one package at a time: the role streamiq_app is the cluster's, and
// concurrent CREATE or ALTER ROLEs of it fail. The lock is on the server's own database
// (advisory locks are per database), held by this connection until it closes.
func open(ctx context.Context) (*db.DB, error) {
	conn, err := pgx.Connect(ctx, Postgres)
	if err != nil {
		return nil, err
	}
	defer func() { _ = conn.Close(ctx) }()
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(726)`); err != nil {
		return nil, err
	}
	return db.Open(ctx, OwnerURL, AppPassword)
}

// startPair runs a Postgres and an emulator for this package alone.
func startPair() (stop func()) {
	_, file, _, _ := runtime.Caller(0)
	repo := filepath.Join(filepath.Dir(file), "..", "..", "..")
	fb := filepath.Join(repo, "dev", "firebase")
	pg := docker(
		"run",
		"-d",
		"--rm",
		"-e",
		"POSTGRES_PASSWORD=dev",
		"--tmpfs",
		"/var/lib/postgresql",
		"-p",
		"127.0.0.1::5432",
		postgresPin(repo),
	)
	em := docker("run", "-d", "--rm", "-p", "127.0.0.1::9099", "-w", "/app", emulatorImage(fb),
		"firebase", "emulators:start", "--only", "auth", "--project", "demo-streamiq")
	Postgres = "postgres://postgres:dev@" + docker("port", pg, "5432/tcp") + "/postgres"
	Emulator = docker("port", em, "9099/tcp")
	return func() { docker("rm", "-f", pg, em) }
}

// postgresPin is the image docker-compose.yml pins, like the e2e stack's.
func postgresPin(repo string) string {
	compose, err := os.ReadFile(filepath.Join(repo, "docker-compose.yml"))
	must(err)
	m := regexp.MustCompile(`image: (postgres:\S+)`).FindSubmatch(compose)
	if m == nil {
		panic("no postgres image pin in docker-compose.yml")
	}
	return string(m[1])
}

// emulatorImage builds dev/firebase under the tag the e2e stack and the .NET tests use
// (a hash of its inputs), only when it's missing.
func emulatorImage(dir string) string {
	h := sha256.New()
	for _, f := range []string{"Dockerfile", "firebase.json"} {
		b, err := os.ReadFile(filepath.Join(dir, f))
		must(err)
		h.Write(b)
	}
	tag := "streamiq-firebase-emulator:" + hex.EncodeToString(h.Sum(nil))[:12]
	if exec.Command("docker", "image", "inspect", tag).Run() != nil {
		docker("build", "-q", "-t", tag, dir)
	}
	return tag
}

func docker(args ...string) string {
	out, err := exec.Command("docker", args...).Output()
	if err != nil {
		panic(fmt.Sprintf("docker %v: %v", args, err))
	}
	return strings.TrimSpace(strings.Split(string(out), "\n")[0])
}

func exec1(ctx context.Context, url, sql string) error {
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close(ctx) }()
	_, err = conn.Exec(ctx, sql)
	return err
}

// NewDatabase is an empty database of its own, as the superuser; for the migration tests.
func NewDatabase(t *testing.T) string {
	t.Helper()
	name := "test_" + strings.ToLower(rand.Text()[:10])
	if err := exec1(t.Context(), Postgres, `CREATE DATABASE `+name); err != nil {
		t.Fatal(err)
	}
	return withDB(Postgres, name)
}

func withDB(url, name string) string {
	i := strings.LastIndex(url, "/")
	return url[:i+1] + name
}

// AppConfig connects to this package's database as streamiq_app, like the API.
func AppConfig(t *testing.T) *pgxpool.Config {
	t.Helper()
	cfg, err := pgxpool.ParseConfig(OwnerURL)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.User, cfg.ConnConfig.Password = db.AppRole, AppPassword
	return cfg
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

// eventually polls the wall clock: only for containers starting, in Run, before any test.
func eventually(limit time.Duration, f func() error) (err error) {
	for end := time.Now().Add(limit); time.Now().Before(end); time.Sleep(250 * time.Millisecond) {
		if err = f(); err == nil {
			return nil
		}
	}
	return err
}

// Reset empties every table (the emulator keeps its accounts).
func Reset(t *testing.T) {
	t.Helper()
	Exec(t, `TRUNCATE users, tenants CASCADE`)
}

// Exec runs sql as the owner.
func Exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	if _, err := Owner.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

// Scalar is sql's one value, as the owner.
func Scalar[T any](t *testing.T, sql string, args ...any) (v T) {
	t.Helper()
	if err := Owner.QueryRow(t.Context(), sql, args...).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

// Token is a real ID token from the emulator for email (the account is made on first
// use): it goes through the same VerifyIDToken as a production token.
func Token(t *testing.T, email string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"email": email, "password": "password123", "returnSecureToken": true})
	for _, op := range []string{"signUp", "signInWithPassword"} {
		rs, err := http.Post(
			"http://"+Emulator+"/identitytoolkit.googleapis.com/v1/accounts:"+op+"?key=fake-api-key",
			"application/json",
			bytes.NewReader(body),
		)
		if err != nil {
			t.Fatal(err)
		}
		var out struct{ IDToken string }
		_ = json.NewDecoder(rs.Body).Decode(&out)
		_ = rs.Body.Close()
		if out.IDToken != "" {
			return out.IDToken
		}
	}
	t.Fatalf("no ID token for %s", email)
	return ""
}

// Household adds a household with userID as its role ("admin" or "member") and returns its id.
func Household(t *testing.T, userID, role string) string {
	t.Helper()
	id := Scalar[string](t, `INSERT INTO tenants ("Id", "Name") VALUES (uuidv7(), 'home') RETURNING "Id"::text`)
	Join(t, userID, id, role)
	return id
}

// Join makes userID a member of household.
func Join(t *testing.T, userID, household, role string) {
	t.Helper()
	Exec(t, `INSERT INTO memberships ("TenantId", "UserId", "Role") VALUES ($1, $2, $3)`, household, userID, role)
}
