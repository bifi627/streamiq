package main

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"streamiq/gateway/internal/update"
)

func TestLoadEnvFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "gateway.env")
	os.WriteFile(p, []byte("# comment\n\nSTREAMIQ_T_A = from-file\nSTREAMIQ_T_B=from-file\nnot a pair\n"), 0o600)
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
		t.Fatalf("gateway -h lost its '  backup ' line (the installers' pre-update backup check reads it): %v\n%s", err, out)
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
