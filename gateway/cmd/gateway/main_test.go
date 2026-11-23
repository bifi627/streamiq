package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"streamiq/gateway/internal/history"
	"streamiq/gateway/internal/onboarding"
	"streamiq/gateway/internal/pairing"
	"streamiq/gateway/internal/screen"
	"streamiq/gateway/internal/telemetry"
	"streamiq/gateway/internal/tunnel"
	"streamiq/gateway/internal/update"
)

func TestLoadEnvFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "gateway.env")
	if err := os.WriteFile(
		p,
		[]byte("# comment\n\nSTREAMIQ_T_A = from-file\nSTREAMIQ_T_B=from-file\nnot a pair\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	t.Setenv("STREAMIQ_T_B", "from-env")
	os.Unsetenv("STREAMIQ_T_A")
	t.Cleanup(func() { os.Unsetenv("STREAMIQ_T_A") })
	loadEnvFile(p)
	if got := os.Getenv("STREAMIQ_T_A"); got != "from-file" {
		t.Errorf("STREAMIQ_T_A = %q, want from-file", got)
	}
	if got := os.Getenv("STREAMIQ_T_B"); got != "from-env" {
		t.Errorf("STREAMIQ_T_B = %q, want from-env (real env wins)", got)
	}
	loadEnvFile(filepath.Join(t.TempDir(), "missing")) // no-op, no panic
}

// install.sh / install.ps1 look for this line in `gateway -h` to know the
// installed binary can back itself up before an update (#296).
func TestUsageListsBackup(t *testing.T) {
	out, err := execute(t, "-h")
	if err != nil || !regexp.MustCompile(`(?m)^  backup `).MatchString(out) {
		t.Fatalf(
			"gateway -h lost its '  backup ' line (the installers' pre-update backup check reads it): %v\n%s",
			err,
			out,
		)
	}
}

// Wrong input is a usage error (main prints the usage, exits 2); a typo gets a hint.
func TestUsageErrors(t *testing.T) {
	for _, tc := range []struct{ args, want string }{
		{"bakup", "Did you mean this?\n\tbackup"},
		{"jellyfin", `"gateway jellyfin" needs a command`},
		{"jellyfin ofline on", "Did you mean this?\n\toffline"},
		{"jellyfin offline maybe", `invalid argument "maybe"`},
		{"jellyfin offline", "accepts 1 arg(s), received 0"},
		{"service install now", "unknown command"},
		{"backup a b", "accepts at most 1 arg(s)"},
		{"restore", "accepts 1 arg(s), received 0"},
		{"restore --frce x", "unknown flag: --frce"},
	} {
		_, err := execute(t, strings.Fields(tc.args)...)
		if !errors.As(err, new(usageError)) || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("gateway %s: %v, want a usage error with %q", tc.args, err, tc.want)
		}
	}
}

// Help per command, with its Example section.
func TestCommandHelp(t *testing.T) {
	out, err := execute(t, "help", "jellyfin", "gpu")
	if err != nil || !strings.Contains(out, "Examples:\n  gateway jellyfin gpu nvidia") {
		t.Fatalf("help jellyfin gpu: %v\n%s", err, out)
	}
	// "help" as an argument is a help request, not a backup file named help.
	if out, err := execute(t, "backup", "help"); err != nil || !strings.Contains(out, "Examples:\n  gateway backup") {
		t.Fatalf("backup help: %v\n%s", err, out)
	}
}

func execute(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var out strings.Builder
	root := newRoot(t.Context(), filepath.Join(t.TempDir(), "gateway"))
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetArgs(args)
	_, err := root.ExecuteC()
	return out.String(), err
}

// /streamiq/status's remoteUpdate (#312): true when possible, else the reason.
func TestRemoteUpdateStatus(t *testing.T) {
	r := &update.Remote{Version: "1.4.0", Supported: true, Task: func() bool { return true },
		Newer: func() string { return "1.5.0" }}
	if got := remoteUpdate(r); got != true {
		t.Fatalf("possible: %v, want true", got)
	}
	r.Task = func() bool { return false }
	if got, ok := remoteUpdate(r).(string); !ok || !strings.HasPrefix(got, "no logon task") {
		t.Fatalf("no task: %v, want the reason", remoteUpdate(r))
	}
}

// The shipped route table (#434): name, update and telemetry are admin-only (a member gets
// 403 and nothing happens), the rest answer a member too.
func TestGatewayAPIRoutes(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(
		filepath.Join(dir, "gateway.json"),
		[]byte(`{"gatewayId":"g1","credential":"c","name":"nas"}`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	st, err := onboarding.LoadOrEnroll(context.Background(), dir, "", "", "fp")
	if err != nil {
		t.Fatal(err)
	}
	store, _ := pairing.Open(dir)
	started := 0
	remote := &update.Remote{
		Version:   "1.4.0",
		Supported: true,
		Newer:     func() string { return "1.5.0" },
		Task:      func() bool { return true },
		Start:     func() (func(), error) { started++; return func() {}, nil },
	}
	rt := gatewayAPI(
		st,
		remote,
		store,
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }),
		&telemetry.Switch{Dir: dir, Changed: st.Beat},
		&history.Health{Store: &history.Store{Dir: filepath.Join(dir, history.Dir), Kind: "health"}},
		&history.Tunnels{Store: &history.Store{Dir: filepath.Join(dir, history.Dir), Kind: "tunnels"}},
	)
	for _, c := range []struct {
		role, method, path, body string
		want                     int
	}{
		{tunnel.Member, "POST", onboarding.NamePath, `{"name":"mine"}`, http.StatusForbidden},
		{tunnel.Member, "POST", update.Path, "", http.StatusForbidden},
		{tunnel.Member, "POST", telemetry.Path, `{"level":"full"}`, http.StatusForbidden},
		{tunnel.Member, "GET", tunnel.StatusPath, "", http.StatusNoContent},
		{tunnel.Member, "GET", pairing.ClientsPath, "", http.StatusOK},
		{tunnel.Member, "GET", history.HealthPath, "", http.StatusOK},
		{tunnel.Member, "GET", history.TunnelsPath, "", http.StatusOK},
		{tunnel.Member, "GET", history.SummaryPath, "", http.StatusForbidden},
		{tunnel.Member, "POST", history.ThroughputPath, `{"throughputKbps":5}`, http.StatusNoContent},
		{tunnel.Admin, "GET", history.SummaryPath, "", http.StatusOK},
		{tunnel.Member, "GET", screen.ScreensPath, "", http.StatusOK},
		{tunnel.Admin, "POST", onboarding.NamePath, `{"name":"Den"}`, http.StatusOK},
		{tunnel.Admin, "POST", update.Path, "", http.StatusAccepted},
		{tunnel.Admin, "POST", telemetry.Path, `{"level":"full"}`, http.StatusOK},
	} {
		if s, _, _, _ := tunnel.Do(rt, tunnel.Session{Role: c.role}, c.method, c.path, c.body); s != c.want {
			t.Errorf("%s %s %s: %d, want %d", c.role, c.method, c.path, s, c.want)
		}
	}
	if st.CurrentName() != "Den" || started != 1 {
		t.Fatalf("name %q, updates started %d: a member's call went through", st.CurrentName(), started)
	}
}

// Ctrl+C during `jellyfin login` exits 130; main's stop() after a successful
// login cancels ctx too, and must not (#635).
func TestExitOnCancel(t *testing.T) {
	codes := make(chan int, 1)
	ctx, cancel := context.WithCancel(context.Background())
	exitOnCancel(ctx, func(c int) { codes <- c })
	cancel()
	if c := <-codes; c != 130 {
		t.Fatalf("Ctrl+C: exit %d, want 130", c)
	}
	ctx, cancel = context.WithCancel(context.Background())
	exitOnCancel(ctx, func(c int) { codes <- c })()
	cancel()
	select {
	case c := <-codes:
		t.Fatalf("exit %d after the login was done", c)
	default:
	}
}
