package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	if !strings.Contains(usage, "\n  backup ") {
		t.Fatal("usage lost its '  backup ' line: the installers' pre-update backup check reads it")
	}
}
