package jellyfin

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const shipped = "../../install/jellyfin-compose.yml"

func readFile(t *testing.T, f string) string {
	t.Helper()
	b, err := os.ReadFile(f)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// offline off/on swaps exactly the marked lines, LF and CRLF alike, and on/off
// again changes nothing.
func TestSetOffline(t *testing.T) {
	for _, nl := range []string{"\n", "\r\n"} {
		on := strings.ReplaceAll(readFile(t, shipped), "\n", nl)
		off := on
		for _, r := range [][2]string{
			{"    # ports:", "    ports:"}, {`      # - "8096:8096"`, `      - "8096:8096"`},
			{"    networks: [jail]", "    # networks: [jail]"},
			{"  forwarder:", "  # forwarder:"}, {"    image: alpine", "    # image: alpine"},
			{"    command: tcp", "    # command: tcp"}, {"    depends_on:", "    # depends_on:"},
			{"    ports:" + nl + `      - "8096:8096"` + nl + "    networks: [jail, default]", "    # ports:" + nl + `      # - "8096:8096"` + nl + "    # networks: [jail, default]"},
			{"networks:" + nl + "  jail:" + nl + "    internal: true", "# networks:" + nl + "  # jail:" + nl + "    # internal: true"},
		} {
			if strings.Count(off, r[0]) != 1 {
				t.Fatalf("%q: %d times", r[0], strings.Count(off, r[0]))
			}
			off = strings.Replace(off, r[0], r[1], 1)
		}
		// The forwarder's restart: line is the second one, after jellyfin's.
		i := strings.LastIndex(off, "    restart: unless-stopped")
		off = off[:i] + "    # restart: unless-stopped" + off[i+len("    restart: unless-stopped"):]

		got, changed, err := SetOffline([]byte(on), false)
		if err != nil || !changed || string(got) != off {
			t.Fatalf("off: changed %v, err %v\n%s", changed, err, got)
		}
		got, changed, err = SetOffline(got, true)
		if err != nil || !changed || string(got) != on {
			t.Fatalf("on again: changed %v, err %v\n%s", changed, err, got)
		}
		if got, changed, err = SetOffline(got, true); changed || err != nil || string(got) != on {
			t.Fatalf("on twice: changed %v, err %v", changed, err)
		}
	}
}

// A file the toggle doesn't recognize is an error, never a guess.
func TestSetOfflineUnknownShape(t *testing.T) {
	on := readFile(t, shipped)
	for name, in := range map[string]string{
		"no markers":     readFile(t, "testdata/jellyfin-compose-pre321.yml"),
		"no end":         strings.Replace(on, "    # streamiq:jail end", "", 1),
		"half commented": strings.Replace(on, "    networks: [jail]", "    # networks: [jail]", 1),
		"both on":        strings.Replace(strings.Replace(on, "    # ports:", "    ports:", 1), `      # - "8096`, `      - "8096`, 1),
		"own comment":    strings.Replace(on, "    networks: [jail]", "    networks: [jail]\n    #mine", 1),
	} {
		if _, _, err := SetOffline([]byte(in), false); !errors.Is(err, errShape) {
			t.Errorf("%s: err %v, want errShape", name, err)
		}
	}
}

// The migration of a pre-#321 file: exact output for a small one (comments,
// mounts, GPU blocks and CRLF stay), the old shipped file ends up jailed and
// toggleable, a file with markers keeps the user's choice.
func TestJail(t *testing.T) {
	in := "# mine\r\nservices:\r\n  jellyfin:\r\n    image: x\r\n    ports:\r\n      - \"127.0.0.1:18096:8096\"\r\n    volumes:\r\n      - ./m:/media # mine\r\n    # deploy:\r\n    #   gpu\r\n# vols\r\nvolumes:\r\n  cache:\r\n"
	want := "# mine\r\nservices:\r\n  jellyfin:\r\n    image: x\r\n" +
		"    # streamiq:online\r\n    # ports:\r\n      # - \"127.0.0.1:18096:8096\"\r\n    # streamiq:online end\r\n" +
		"    # streamiq:jail\r\n    networks: [jail]\r\n    # streamiq:jail end\r\n" +
		"    volumes:\r\n      - ./m:/media # mine\r\n    # deploy:\r\n    #   gpu\r\n" +
		"  # Offline (#321): the only way in to Jellyfin; `gateway jellyfin offline off` removes it.\r\n" +
		"  # streamiq:jail\r\n  forwarder:\r\n    image: " + Forwarder + "\r\n    restart: unless-stopped\r\n" +
		"    command: tcp-listen:8096,fork,reuseaddr tcp-connect:jellyfin:8096\r\n    depends_on: [jellyfin]\r\n" +
		"    ports:\r\n      - \"127.0.0.1:18096:8096\"\r\n    networks: [jail, default]\r\n  # streamiq:jail end\r\n" +
		"# vols\r\nvolumes:\r\n  cache:\r\n" +
		"# streamiq:jail\r\nnetworks:\r\n  jail:\r\n    internal: true\r\n# streamiq:jail end\r\n"
	got, changed, err := Jail([]byte(in))
	if err != nil || !changed || string(got) != want {
		t.Fatalf("Jail: changed %v, err %v\n%q\nwant\n%q", changed, err, got, want)
	}

	// Another service naming jellyfin: in its depends_on: above it doesn't hide
	// the service: jailed like the file without that service (#584).
	web := "services:\r\n  web:\r\n    image: w\r\n    depends_on:\r\n      jellyfin:\r\n        condition: service_started\r\n"
	got, changed, err = Jail([]byte(strings.Replace(in, "services:\r\n", web, 1)))
	if err != nil || !changed || string(got) != strings.Replace(want, "services:\r\n", web, 1) {
		t.Fatalf("Jail with a nested jellyfin: first: changed %v, err %v\n%q", changed, err, got)
	}

	// A mount commented out at column 0 is still inside the jellyfin service:
	// the forwarder goes after all of it, not in the middle (review of #355).
	mounts := strings.Replace(
		readFile(t, "testdata/jellyfin-compose-pre321.yml"),
		"      - ./jellyfin-config:/config",
		"#      - ./jellyfin-config:/config",
		1,
	)
	got, _, err = Jail([]byte(mounts))
	if err != nil || strings.Index(string(got), "forwarder:") < strings.Index(string(got), "read_only: true") ||
		!strings.Contains(string(got), "#      - ./jellyfin-config:/config\n      - cache:/cache") {
		t.Fatalf("column-0 comment in the service: err %v\n%s", err, got)
	}

	old := readFile(t, "testdata/jellyfin-compose-pre321.yml")
	jailed, changed, err := Jail([]byte(old))
	if err != nil || !changed {
		t.Fatalf("old shipped file: changed %v, err %v", changed, err)
	}
	if Offline(write(t, jailed)) != OfflineEnforced {
		t.Fatalf("not jailed:\n%s", jailed)
	}
	online, _, err := SetOffline(jailed, false)
	if err != nil {
		t.Fatal(err)
	}
	// Online again = the old file plus marker and commented lines only.
	var kept []string
	for _, l := range strings.Split(string(online), "\n") {
		if t := strings.TrimSpace(l); t != "" && !strings.HasPrefix(t, "#") {
			kept = append(kept, l)
		}
	}
	var was []string
	for _, l := range strings.Split(old, "\n") {
		if t := strings.TrimSpace(l); t != "" && !strings.HasPrefix(t, "#") {
			was = append(was, l)
		}
	}
	if strings.Join(kept, "\n") != strings.Join(was, "\n") {
		t.Fatalf("online after migration differs from the old file:\n%s", online)
	}
	if again, changed, err := Jail(online); changed || err != nil || string(again) != string(online) {
		t.Fatalf("a jail turned off was migrated again: changed %v, err %v", changed, err)
	}
}

func TestJailUnknownShape(t *testing.T) {
	for name, in := range map[string]string{
		"no jellyfin":            "services:\n  media:\n    ports:\n      - 1:1\n",
		"only nested jellyfin":   "services:\n  web:\n    depends_on:\n      jellyfin:\n        condition: service_started\n    ports:\n      - 1:1\n",
		"no ports":               "services:\n  jellyfin:\n    image: x\n",
		"own networks":           "services:\n  jellyfin:\n    ports: [\"1:1\"]\nnetworks:\n  x: {}\n",
		"service network":        "services:\n  jellyfin:\n    network_mode: host\n    ports: [\"1:1\"]\n",
		"comment in ports":       "services:\n  jellyfin:\n    ports:\n      # - 1900:1900\n      - 1:1\n",
		"ports at key indent":    "services:\n  jellyfin:\n    image: x\n    ports:\n    - \"8096:8096\"\n    volumes:\n    - ./c:/config\n",
		"col-0 comment in ports": "services:\n  jellyfin:\n    ports:\n      - \"8096:8096\"\n#      - \"1900:1900/udp\"\n      - \"7359:7359/udp\"\n    image: x\n",
		"blank in ports":         "services:\n  jellyfin:\n    ports:\n      - 1:1\n\n      - 2:2\n    image: x\n",
	} {
		if _, _, err := Jail([]byte(in)); !errors.Is(err, errShape) {
			t.Errorf("%s: err %v, want errShape", name, err)
		}
	}
}

// The services: block ends at the next top-level key, less the column-0
// comments right above it; a column-0 comment elsewhere doesn't end it.
func TestJellyfinService(t *testing.T) {
	for name, c := range map[string]struct {
		in       string
		svc, end int
	}{
		"to the end":        {"services:\n  jellyfin:\n    image: x\n", 1, 3},
		"next key":          {"services:\n  jellyfin:\n    image: x\nvolumes:\n", 1, 3},
		"comment above key": {"services:\n  jellyfin:\n#   x\n    image: x\n# vols\n# more\nvolumes:\n", 1, 4},
		"second service":    {"services:\n  media:\n    image: y\n  jellyfin:\n    image: x\n", 3, 5},
		"no jellyfin":       {"services:\n  media:\n    image: y\nvolumes:\n  jellyfin:\n", -1, 3},
		"no services":       {"volumes:\n  jellyfin:\n", -1, 2},
		"nested first":      {"services:\n  web:\n    depends_on:\n      jellyfin:\n        condition: service_started\n  jellyfin:\n    image: x\n", 5, 7},
		"only nested":       {"services:\n  web:\n    depends_on:\n      jellyfin:\n", -1, 4},
	} {
		ls := lines([]byte(c.in))
		if svc, end := jellyfinService(ls[:len(ls)-1]); svc != c.svc || end != c.end {
			t.Errorf("%s: %d, %d; want %d, %d", name, svc, end, c.svc, c.end)
		}
	}
}

// The items of ports: run to the first line not indented deeper than the keys;
// a comment among them, or an item after a blank line or column-0 comment, is refused.
func TestPortItems(t *testing.T) {
	for name, c := range map[string]struct {
		in  string
		end int // -1: refused
	}{
		"items":            {"    ports:\n      - 1:1\n      - 2:2\n    image: x\n", 3},
		"last key":         {"    ports:\n      - 1:1\n", 2},
		"flow":             {"    ports: [\"1:1\"]\n    image: x\n", 1},
		"blank after":      {"    ports:\n      - 1:1\n\n    image: x\n", 2},
		"comment after":    {"    ports:\n      - 1:1\n    # deploy:\n    image: x\n", 2},
		"comment inside":   {"    ports:\n      # - 1900:1900\n      - 1:1\n", -1},
		"blank inside":     {"    ports:\n      - 1:1\n\n      - 2:2\n", -1},
		"col-0 comment in": {"    ports:\n      - 1:1\n#      - 2:2\n      - 3:3\n", -1},
	} {
		ls := lines([]byte(c.in))
		ls = ls[:len(ls)-1]
		end, err := portItems(ls, 0, len(ls), 4)
		if c.end < 0 && !errors.Is(err, errShape) || c.end >= 0 && (err != nil || end != c.end) {
			t.Errorf("%s: %d, %v; want %d", name, end, err, c.end)
		}
	}
}

func TestServiceKey(t *testing.T) {
	if k, err := serviceKey("    ports:\n", 0); k != "ports" || err != nil {
		t.Errorf("ports: %q, %v", k, err)
	}
	for _, l := range []string{"    - x\n", "    networks: [a]\n", "    network_mode: host\n"} {
		if _, err := serviceKey(l, 0); !errors.Is(err, errShape) {
			t.Errorf("%q: %v, want errShape", l, err)
		}
	}
}

// A migration that's refused, with the pin already current, changes nothing:
// no write, no restart, no "now offline" (second review of #355).
func TestUpgradeRefusedMigration(t *testing.T) {
	in := "services:\n  jellyfin:\n    image: " + Image + "\n    ports:\n      - \"8096:8096\"\n#      - \"1900:1900/udp\"\n      - \"7359:7359/udp\"\n"
	f := write(t, []byte(in))
	var out strings.Builder
	if err := Upgrade(t.Context(), f, &out); err != nil {
		t.Fatal(err)
	}
	if got := readFile(
		t,
		f,
	); got != in || strings.Contains(out.String(), "now offline") || !strings.Contains(out.String(), "Not moved into the offline jail") ||
		!strings.Contains(out.String(), "Already on") {
		t.Fatalf("output %q, file changed: %v", out.String(), got != in)
	}
}

func write(t *testing.T, b []byte) string {
	t.Helper()
	f := filepath.Join(t.TempDir(), ComposeFile)
	if err := os.WriteFile(f, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestOfflineState(t *testing.T) {
	if got := Offline(filepath.Join(t.TempDir(), ComposeFile)); got != "" {
		t.Errorf("no file: %q", got)
	}
	on := readFile(t, shipped)
	off, _, _ := SetOffline([]byte(on), false)
	for f, want := range map[string]string{
		write(t, []byte(on)): OfflineEnforced, write(t, off): OfflineAllowed,
		write(t, []byte(readFile(t, "testdata/jellyfin-compose-pre321.yml"))): OfflineAllowed,
	} {
		if got := Offline(f); got != want {
			t.Errorf("%s: %q, want %q", f, got, want)
		}
	}
}

// Both shipped variants, the GPU on and a migrated old file parse (`docker compose config`,
// no pull). Docker is there in CI; a dev box without it skips.
func TestComposeVariantsParse(t *testing.T) {
	if exec.Command("docker", "compose", "version").Run() != nil {
		if os.Getenv("CI") != "" {
			t.Fatal("docker compose missing in CI")
		}
		t.Skip("no docker compose")
	}
	on := []byte(readFile(t, shipped))
	off, _, _ := SetOffline(on, false)
	migrated, _, _ := Jail([]byte(readFile(t, "testdata/jellyfin-compose-pre321.yml")))
	gpu, _, _ := SetGPU(on, true)
	folder, _, err := AddMount(on, t.TempDir(), filepath.Join(t.TempDir(), "My 'Films'"), "")
	if err != nil {
		t.Fatal(err)
	}
	variants := map[string][]byte{"on": on, "off": off, "migrated": migrated, "gpu": gpu, "folder": folder}
	for name, b := range variants {
		if out, err := exec.Command("docker", "compose", "-f", write(t, b), "config", "--quiet").
			CombinedOutput(); err != nil {
			t.Errorf("%s: %v: %s", name, err, out)
		}
	}
}
