package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"maps"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"streamiq/gateway/internal/identity"
	"streamiq/gateway/internal/onboarding"
	"streamiq/gateway/internal/pairing"
	"streamiq/gateway/internal/service"
	"streamiq/gateway/internal/update"
)

// The update test (#452): `gateway update` from the last published release to
// this commit's build, then `gateway rollback`, against a release served here.
// STREAMIQ_TEST_OLD_GATEWAY is the last release's Windows binary (CI downloads
// it); without it only the cases that need two builds of this commit run.

const newVersion = "999.0.0" // this commit's build, as the served release

// The state an installed gateway has today. cert.pem is written by the old
// release itself (reset-identity); these are the files it writes once enrolled,
// paired and set up, in its format (onboarding, pairing, jellyfin): fixtures,
// since only the API, a paired browser and a Jellyfin make it write them. They
// follow the format users have: a PR that changes one updates it here (the
// types say so). ponytail: a state dir from a real old release (e2e) is the upgrade path.
var oldState = map[string]string{
	"gateway.json":   `{"credential":"cred-1","gatewayId":"7d1c1f0e-4b7a-4c55-9a43-2f1a8e1f3b10","name":"nas"}`,
	"allowlist.json": "[\n {\n  \"keyFp\": \"sha-256 AA:BB\",\n  \"name\": \"Phone\",\n  \"addedAt\": \"2026-11-17T08:00:00Z\"\n }\n]",
	"jellyfin.json":  `{"token":"tok","viewer":"streamiq","viewerId":"v1","viewerPassword":"vpw","user":"admin","password":"apw","byo":true}`,
}

func TestUpdateFromLastRelease(t *testing.T) {
	old := os.Getenv("STREAMIQ_TEST_OLD_GATEWAY")
	if old == "" {
		t.Skip("STREAMIQ_TEST_OLD_GATEWAY not set (the last release's streamiq-gateway-windows-amd64.exe)")
	}
	install, _ := setup(t, newVersion)
	exe := filepath.Join(install, "gateway.exe")
	if err := os.WriteFile(exe, read(t, old), 0o755); err != nil {
		t.Fatal(err)
	}
	updateAndRollBack(t, install)
}

// This commit's update and restore code, as the release after it will run
// them: a build of this commit is the "old" release. Always runs, so that code
// is tested before it ships.
func TestUpdateFromThisCommit(t *testing.T) {
	install, _ := setup(t, newVersion)
	build(t, filepath.Join(install, "gateway.exe"), "1.0.0")
	updateAndRollBack(t, install)
}

// updateAndRollBack updates the gateway installed in install to the served
// release, then rolls back.
func updateAndRollBack(t *testing.T, install string) {
	exe := filepath.Join(install, "gateway.exe")
	state := os.Getenv("STREAMIQ_STATE_DIR")
	oldBin := read(t, exe)
	oldVersion := strings.TrimSpace(gateway(t, exe, install, "version"))
	t.Logf("updating from v%s", oldVersion)

	gateway(t, exe, install, "reset-identity") // the old release writes its identity
	for f, b := range oldState {
		if err := os.WriteFile(filepath.Join(state, f), []byte(b), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	_, fp, _ := identity.LoadOrCreate(state)
	before := files(t, state)

	// The old binary runs the update, if it can be pointed at our release (the
	// releases after #452). ponytail: the ones before only ask GitHub, so this
	// commit's update code runs in their place, with the old binary installed.
	if bytes.Contains(oldBin, []byte("STREAMIQ_LATEST")) {
		gateway(t, exe, install, "update")
	} else {
		t.Logf("v%s predates STREAMIQ_LATEST: this commit's update code stands in for its own", oldVersion)
		v := version
		version = oldVersion
		err := selfUpdate(t.Context(), exe)
		version = v
		if err != nil {
			t.Fatal(err)
		}
	}

	if got := strings.TrimSpace(gateway(t, exe, install, "version")); got != newVersion {
		t.Fatalf("after the update the binary is v%s, want v%s", got, newVersion)
	}
	noFile(t, exe+".new")
	dirs := backupDirs(t, install)
	if len(dirs) != 1 || !strings.HasSuffix(dirs[0], "-"+oldVersion) {
		t.Fatalf("backups: %v, want one dir for v%s", dirs, oldVersion)
	}
	keep := filepath.Join(install, update.Backups, dirs[0])
	if !bytes.Equal(read(t, filepath.Join(keep, "gateway.exe")), oldBin) {
		t.Fatal("the old binary isn't kept in the backup dir")
	}
	zr, err := zip.OpenReader(filepath.Join(keep, update.StateZip))
	if err != nil {
		t.Fatal(err)
	}
	var zipped []string
	for _, f := range zr.File {
		zipped = append(zipped, f.Name)
	}
	zr.Close()
	for f := range before {
		if !slices.Contains(zipped, f) {
			t.Errorf("state backup lacks %s (has %v)", f, zipped)
		}
	}

	// The new build reads the old state: a format change without a migration
	// fails here. A deliberate break (feat!) changes this expectation, in its PR.
	if _, got, err := identity.LoadOrCreate(state); err != nil || got != fp {
		t.Fatalf("identity after the update: %q, %v; want %q (the old one)", got, err, fp)
	}
	ps, err := pairing.Open(state)
	if err != nil {
		t.Fatalf("allowlist.json after the update: %v", err)
	}
	if p := ps.Paired(); len(p) != 1 || p[0].KeyFp != "sha-256 AA:BB" {
		t.Fatalf("paired clients after the update: %+v, want the old one", p)
	}
	if st, err := onboarding.LoadOrEnroll(t.Context(), state, "", "", fp); err != nil || st.GatewayID != "7d1c1f0e-4b7a-4c55-9a43-2f1a8e1f3b10" {
		t.Fatalf("gateway.json after the update: %+v, %v; want the old gateway id", st, err)
	}
	if err := jellyfinSetup().Load(); err != nil {
		t.Fatalf("jellyfin.json after the update: %v", err)
	}
	// What the new version may have changed since: rollback puts it back.
	if err := os.WriteFile(filepath.Join(state, "allowlist.json"), []byte("[]"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(state, "new-in-this-version.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}

	gateway(t, exe, install, "rollback")
	if !bytes.Equal(read(t, exe), oldBin) {
		t.Fatal("after the rollback the binary isn't the old release")
	}
	if after := files(t, state); !maps.Equal(after, before) {
		t.Fatalf("after the rollback the state is %v, want the old release's %v", slices.Sorted(maps.Keys(after)), slices.Sorted(maps.Keys(before)))
	}
	if dirs := backupDirs(t, install); len(dirs) != 0 {
		t.Fatalf("backups after the rollback: %v, want none (used up)", dirs)
	}
	// Still running when the rollback ends (it was that process): the next update removes it.
	if !bytes.Equal(read(t, exe+".old"), built[newVersion]) {
		t.Fatal("gateway.exe.old isn't the build rolled back from")
	}
}

// A failed backup changes nothing: no state to back up (no identity).
func TestUpdateBackupFails(t *testing.T) {
	install, _ := setup(t, newVersion)
	exe := filepath.Join(install, "gateway.exe")
	build(t, exe, "1.0.0")
	bin := read(t, exe)
	out, err := runExe(exe, install, "update")
	if err == nil || !strings.Contains(out, "nothing changed") {
		t.Fatalf("update with nothing to back up: %v\n%s", err, out)
	}
	if !bytes.Equal(read(t, exe), bin) {
		t.Fatal("the binary changed")
	}
	noFile(t, exe+".new")
	if dirs := backupDirs(t, install); len(dirs) != 0 {
		t.Fatalf("backups left behind: %v", dirs)
	}
}

func TestUpdateUpToDate(t *testing.T) {
	install, _ := setup(t, newVersion)
	exe := filepath.Join(install, "gateway.exe")
	build(t, exe, newVersion)
	bin := read(t, exe)
	if out := gateway(t, exe, install, "update"); !strings.Contains(out, "Up to date") {
		t.Fatalf("update: %s, want up to date", out)
	}
	if !bytes.Equal(read(t, exe), bin) {
		t.Fatal("the binary changed")
	}
	noFile(t, exe+".new")
	noFile(t, filepath.Join(install, update.Backups))
}

// setup serves this commit's build as release v<latest> and points the
// gateway (this process and the binaries it starts) at it and at an install dir.
func setup(t *testing.T, latest string) (install, state string) {
	if service.Installed() {
		t.Skip("the logon task " + service.Task + " is installed here: update and rollback would stop it")
	}
	served := filepath.Join(t.TempDir(), "new.exe")
	build(t, served, latest)
	bin := read(t, served)
	sum := sha256.Sum256(bin)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latest":
			fmt.Fprintf(w, `{"tag_name":"gateway-v%s"}`, latest)
		case "/download/SHA256SUMS":
			fmt.Fprintf(w, "%s  %s\n", hex.EncodeToString(sum[:]), update.Asset())
		case "/download/" + update.Asset():
			_, _ = w.Write(bin)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	install = t.TempDir()
	state = filepath.Join(install, "state")
	if err := os.Mkdir(state, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("STREAMIQ_LATEST", srv.URL+"/latest")
	t.Setenv("STREAMIQ_DOWNLOAD", srv.URL+"/download")
	t.Setenv("STREAMIQ_STATE_DIR", state)
	t.Setenv("STREAMIQ_PAGE_PORT", freePort(t))                  // no gateway running
	t.Setenv("STREAMIQ_ORIGIN", "http://127.0.0.1:"+freePort(t)) // no Jellyfin
	return install, state
}

var built = map[string][]byte{} // version → binary: one build each

func build(t *testing.T, dst, v string) {
	t.Helper()
	if b, ok := built[v]; ok {
		if err := os.WriteFile(dst, b, 0o755); err != nil {
			t.Fatal(err)
		}
		return
	}
	if out, err := exec.Command("go", "build", "-ldflags", "-X main.version="+v, "-o", dst, ".").CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	built[v] = read(t, dst)
}

func gateway(t *testing.T, exe, dir string, args ...string) string {
	t.Helper()
	out, err := runExe(exe, dir, args...)
	if err != nil {
		t.Fatalf("gateway %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return out
}

func runExe(exe, dir string, args ...string) (string, error) {
	c := exec.Command(exe, args...)
	c.Dir = dir
	out, err := c.CombinedOutput()
	return string(out), err
}

func read(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func files(t *testing.T, dir string) map[string]string {
	t.Helper()
	es, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	m := map[string]string{}
	for _, e := range es {
		m[e.Name()] = string(read(t, filepath.Join(dir, e.Name())))
	}
	return m
}

func backupDirs(t *testing.T, install string) []string {
	t.Helper()
	es, err := os.ReadDir(filepath.Join(install, update.Backups))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	var out []string
	for _, e := range es {
		out = append(out, e.Name())
	}
	return out
}

func noFile(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("%s is there (%v), want it gone", path, err)
	}
}

func freePort(t *testing.T) string {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return fmt.Sprint(l.Addr().(*net.TCPAddr).Port)
}
