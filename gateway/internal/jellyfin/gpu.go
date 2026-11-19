package jellyfin

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// HWAccelKey is the gateway.env line `gateway jellyfin gpu` sets (#334).
const HWAccelKey = "STREAMIQ_JELLYFIN_HWACCEL"

const gpuBlock = "gpu-nvidia"

// oldNvidia is the commented NVIDIA block of the releases before #334, which
// MarkGPU wraps in the markers when it finds it word for word.
var oldNvidia = []string{
	"    # deploy:",
	"    #   resources:",
	"    #     reservations:",
	"    #       devices:",
	"    #         - driver: nvidia",
	"    #           count: all",
	"    #           capabilities: [gpu]",
}

// MarkGPU wraps the old shipped NVIDIA block in `# streamiq:gpu-nvidia` markers
// (the `upgrade` migration); any other file comes back as it is.
func MarkGPU(b []byte) (out []byte, changed bool) {
	if bytes.Contains(b, []byte("# streamiq:"+gpuBlock)) {
		return b, false // has the markers: the user's choice
	}
	ls := lines(b)
	at := -1
	for i := 0; i+len(oldNvidia) <= len(ls); i++ {
		match := true
		for j, want := range oldNvidia {
			if strings.TrimRight(ls[i+j], "\r\n") != want {
				match = false
				break
			}
		}
		if match {
			if at >= 0 {
				return b, false // twice: which one?
			}
			at = i
		}
	}
	if at < 0 {
		return b, false
	}
	nl := ls[at][len(strings.TrimRight(ls[at], "\r\n")):]
	end := at + len(oldNvidia)
	if !strings.HasSuffix(ls[end-1], "\n") { // the last line of the file
		ls[end-1] += "\n"
		nl = "\n"
	}
	res := append(append([]string{}, ls[:at]...), "    # streamiq:"+gpuBlock+nl)
	res = append(append(res, ls[at:end]...), "    # streamiq:"+gpuBlock+" end"+nl)
	return []byte(strings.Join(append(res, ls[end:]...), "")), true
}

// SetGPU (un)comments the marked NVIDIA block; changed is false if it already was.
func SetGPU(b []byte, on bool) (out []byte, changed bool, err error) {
	ls := lines(b)
	cur, err := blockOn(ls, gpuBlock)
	if err != nil {
		return nil, false, err
	}
	idx, _ := marked(ls, gpuBlock)
	nvidia := false
	for _, i := range idx {
		nvidia = nvidia || strings.Contains(ls[i], "driver: nvidia")
	}
	if !nvidia {
		return nil, false, fmt.Errorf("%w: the %q block has no driver: nvidia", errShape, gpuBlock)
	}
	if cur == on {
		return b, false, nil
	}
	if err := setBlock(ls, gpuBlock, on); err != nil {
		return nil, false, err
	}
	return []byte(strings.Join(ls, "")), true, nil
}

// SetEnv sets key=val in a gateway.env (every key= line; appended if there is
// none), or removes the key's lines when val is "". Every other line stays.
func SetEnv(b []byte, key, val string) []byte {
	var res []string
	found := false
	for _, l := range lines(b) {
		k, _, ok := strings.Cut(strings.TrimSpace(l), "=")
		if !ok || strings.TrimSpace(k) != key {
			res = append(res, l)
			continue
		}
		found = true
		if val != "" {
			res = append(res, key+"="+val+l[len(strings.TrimRight(l, "\r\n")):])
		}
	}
	if !found && val != "" {
		nl := "\n"
		if bytes.Contains(b, []byte("\r\n")) {
			nl = "\r\n"
		}
		if n := len(res); n > 0 && res[n-1] != "" && !strings.HasSuffix(res[n-1], "\n") {
			res[n-1] += nl
		}
		res = append(res, key+"="+val+nl)
	}
	return []byte(strings.Join(res, ""))
}

const manualGPU = `To do it by hand (docs/install.md, "GPU transcoding"): uncomment the NVIDIA
deploy: block in jellyfin-compose.yml, set STREAMIQ_JELLYFIN_HWACCEL=nvenc in
gateway.env, run ` + "`gateway jellyfin up`" + ` and restart the gateway.
`

// GPUCLI is `gateway jellyfin gpu nvidia|off`: toggles the NVIDIA block in
// compose and HWAccelKey in envFile, restarts Jellyfin, checks the GPU in its
// container (nvidia), then restart()s the gateway. A failure puts both files
// back as they were.
func GPUCLI(ctx context.Context, compose, envFile string, on bool, restart func() error, out io.Writer) error {
	cb, err := os.ReadFile(compose)
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("no %s: this only works for the Jellyfin `gateway jellyfin up` runs", compose)
	}
	if err != nil {
		return err
	}
	eb, err := os.ReadFile(envFile)
	if err != nil {
		return err // the installer writes it; without it the gateway has no config
	}
	nc, cChanged, err := SetGPU(cb, on)
	if err != nil {
		fmt.Fprintf(out, "%s is unchanged: run `gateway jellyfin upgrade` first.\n%s", compose, manualGPU)
		return err
	}
	val := map[bool]string{true: "nvenc"}[on]
	ne := SetEnv(eb, HWAccelKey, val)
	state := map[bool]string{true: "transcodes on the NVIDIA GPU", false: "transcodes on the CPU"}[on]
	if !cChanged && bytes.Equal(ne, eb) {
		fmt.Fprintln(out, "Jellyfin already", state)
		return nil
	}
	put := func(c, e []byte) error {
		if err := os.WriteFile(compose, c, 0o644); err != nil {
			return err
		}
		return os.WriteFile(envFile, e, 0o600)
	}
	undo := func(why error) error {
		if err := put(cb, eb); err != nil {
			return fmt.Errorf("%w; putting %s and %s back failed too: %v", why, compose, envFile, err)
		}
		if err := Compose(context.WithoutCancel(ctx), compose, "up", "-d"); err != nil {
			return fmt.Errorf("%w; Jellyfin did not come back up: %v (run `gateway jellyfin up`)", why, err)
		}
		fmt.Fprintf(
			out,
			"Nothing changed: %v\nPut %s and %s back as they were. See \"GPU transcoding\" in docs/install.md.\n",
			why,
			compose,
			envFile,
		)
		return why
	}
	if err := put(nc, ne); err != nil {
		return undo(err)
	}
	if err := Compose(ctx, compose, "up", "-d"); err != nil {
		return undo(fmt.Errorf("Docker did not restart Jellyfin: %w", err))
	}
	if on {
		if err := composeQuiet(ctx, compose, "exec", "-T", "jellyfin", "nvidia-smi"); err != nil {
			return undo(fmt.Errorf("no NVIDIA GPU in the Jellyfin container: %w", err))
		}
	}
	fmt.Fprintln(out, "Jellyfin now", state)
	// A gateway restarted from here (install.sh's nohup) inherits this
	// environment, which loadEnvFile filled from the old gateway.env and which
	// wins over the file: give it the new value.
	os.Setenv(HWAccelKey, val)
	return restart()
}
