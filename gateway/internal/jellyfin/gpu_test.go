package jellyfin

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// gpu nvidia/off swaps exactly the NVIDIA block's lines, LF and CRLF alike;
// the jail and the Intel/AMD block stay as they are.
func TestSetGPU(t *testing.T) {
	for _, nl := range []string{"\n", "\r\n"} {
		off := strings.ReplaceAll(readFile(t, shipped), "\n", nl)
		on := off
		for _, l := range oldNvidia {
			on = strings.Replace(on, l+nl, "    "+strings.TrimPrefix(l, "    # ")+nl, 1)
		}
		got, changed, err := SetGPU([]byte(off), true)
		if err != nil || !changed || string(got) != on {
			t.Fatalf("nvidia: changed %v, err %v\n%s", changed, err, got)
		}
		if again, changed, err := SetGPU(got, true); changed || err != nil || string(again) != on {
			t.Fatalf("nvidia twice: changed %v, err %v", changed, err)
		}
		back, changed, err := SetGPU(got, false)
		if err != nil || !changed {
			t.Fatalf("off: changed %v, err %v", changed, err)
		}
		// Commented again the way setBlock comments ("# " after the indent): the
		// same lines, still toggleable.
		if again, _, _ := SetGPU(back, true); string(again) != on {
			t.Fatalf("off then nvidia:\n%s", again)
		}
		if strings.ReplaceAll(string(back), "# ", "") != strings.ReplaceAll(off, "# ", "") {
			t.Fatalf("off changed more than comments:\n%s", back)
		}
		if _, err := blockOn(lines(got), "jail"); err != nil || !strings.Contains(string(got), "    # devices:"+nl+"    #   - /dev/dri") {
			t.Fatalf("other blocks touched: %v\n%s", err, got)
		}
	}
}

func TestSetGPUUnknownShape(t *testing.T) {
	off := readFile(t, shipped)
	for name, in := range map[string]string{
		"no markers":     readFile(t, "testdata/jellyfin-compose-pre321.yml"),
		"no end":         strings.Replace(off, "    # streamiq:gpu-nvidia end\n", "", 1),
		"half commented": strings.Replace(off, "    # deploy:", "    deploy:", 1),
		"not nvidia":     strings.Replace(off, "driver: nvidia", "driver: amd", 1),
	} {
		if _, _, err := SetGPU([]byte(in), true); !errors.Is(err, errShape) {
			t.Errorf("%s: err %v, want errShape", name, err)
		}
	}
}

// upgrade wraps the old block word for word, nothing else.
func TestMarkGPU(t *testing.T) {
	unmarked := strings.Replace(strings.Replace(readFile(t, shipped), "    # streamiq:gpu-nvidia\n", "", 1), "    # streamiq:gpu-nvidia end\n", "", 1)
	got, changed := MarkGPU([]byte(unmarked))
	if !changed || strings.ReplaceAll(string(got), "    # streamiq:gpu-nvidia end\n", "") != strings.ReplaceAll(unmarked, "    # deploy:\n", "    # streamiq:gpu-nvidia\n    # deploy:\n") {
		t.Fatalf("changed %v\n%s", changed, got)
	}
	if _, _, err := SetGPU(got, true); err != nil {
		t.Fatal(err)
	}
	crlf := strings.ReplaceAll(unmarked, "\n", "\r\n")
	if got, _ := MarkGPU([]byte(crlf)); !strings.Contains(string(got), "    # streamiq:gpu-nvidia\r\n    # deploy:\r\n") || strings.Count(string(got), "\n") != strings.Count(string(got), "\r\n") {
		t.Fatalf("CRLF:\n%q", got)
	}
	// The pre-#321 file: jailed by upgrade, then marked.
	jailed, _, err := Jail([]byte(readFile(t, "testdata/jellyfin-compose-pre321.yml")))
	if err != nil {
		t.Fatal(err)
	}
	if got, changed := MarkGPU(jailed); !changed {
		t.Fatal("pre-#321 file not marked")
	} else if _, _, err := SetGPU(got, true); err != nil {
		t.Fatal(err)
	}
	for name, in := range map[string]string{
		"marked":   readFile(t, shipped),
		"edited":   strings.Replace(unmarked, "count: all", "count: 1", 1),
		"switched": strings.Replace(unmarked, "    # deploy:", "    deploy:", 1),
	} {
		if got, changed := MarkGPU([]byte(in)); changed || string(got) != in {
			t.Errorf("%s: changed", name)
		}
	}
}

func TestSetEnv(t *testing.T) {
	for name, c := range map[string][3]string{ // in, val, want
		"replace":       {"A=1\nSTREAMIQ_JELLYFIN_HWACCEL=\n# c\n", "nvenc", "A=1\nSTREAMIQ_JELLYFIN_HWACCEL=nvenc\n# c\n"},
		"replace crlf":  {"A=1\r\n STREAMIQ_JELLYFIN_HWACCEL = x\r\nB=2", "nvenc", "A=1\r\nSTREAMIQ_JELLYFIN_HWACCEL=nvenc\r\nB=2"},
		"append":        {"A=1\n# STREAMIQ_JELLYFIN_HWACCEL=nvenc\n", "nvenc", "A=1\n# STREAMIQ_JELLYFIN_HWACCEL=nvenc\nSTREAMIQ_JELLYFIN_HWACCEL=nvenc\n"},
		"append no nl":  {"A=1\r\nB=2", "nvenc", "A=1\r\nB=2\r\nSTREAMIQ_JELLYFIN_HWACCEL=nvenc\r\n"},
		"append empty":  {"", "nvenc", "STREAMIQ_JELLYFIN_HWACCEL=nvenc\n"},
		"remove":        {"A=1\nSTREAMIQ_JELLYFIN_HWACCEL=nvenc\nB=2\n", "", "A=1\nB=2\n"},
		"remove absent": {"A=1\n", "", "A=1\n"},
		"other key":     {"STREAMIQ_JELLYFIN_HWACCEL_X=1\n", "", "STREAMIQ_JELLYFIN_HWACCEL_X=1\n"},
	} {
		if got := string(SetEnv([]byte(c[0]), HWAccelKey, c[1])); got != c[2] {
			t.Errorf("%s: %q, want %q", name, got, c[2])
		}
	}
}

// Already in the asked state, or a file it can't read: nothing written,
// nothing restarted (no Docker needed).
func TestGPUCLINoChange(t *testing.T) {
	dir := t.TempDir()
	compose, envFile := filepath.Join(dir, ComposeFile), filepath.Join(dir, "gateway.env")
	restarted := false
	restart := func() error { restarted = true; return nil }
	for name, c := range map[string][2]string{
		"already off": {readFile(t, shipped), "A=1\n"},
		"no markers":  {readFile(t, "testdata/jellyfin-compose-pre321.yml"), "A=1\n"},
	} {
		os.WriteFile(compose, []byte(c[0]), 0o644)
		os.WriteFile(envFile, []byte(c[1]), 0o644)
		var out strings.Builder
		err := GPUCLI(t.Context(), compose, envFile, false, restart, &out)
		if name == "no markers" {
			if !errors.Is(err, errShape) || !strings.Contains(out.String(), "gateway jellyfin upgrade") {
				t.Fatalf("no markers: %v %q", err, out.String())
			}
		} else if err != nil || !strings.Contains(out.String(), "already") {
			t.Fatalf("%s: %v %q", name, err, out.String())
		}
		if readFile(t, compose) != c[0] || readFile(t, envFile) != c[1] || restarted {
			t.Fatalf("%s: changed something", name)
		}
	}
}
