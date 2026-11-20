// Transcoding settings: the encoding and server config the gateway owns on a Jellyfin it set up.

package jellyfin

import (
	"context"
	"encoding/json"
	"log/slog"
)

// configSteps are the encoding settings the gateway owns, applied in order and
// once each to a Jellyfin it set up: a fresh one gets all, an existing one the
// ones added since its last update. Append only, never edit or reorder: the
// count applied is stored. Each step sets only its own fields, so a field
// the user changed in the Dashboard later stays changed.
var configSteps = []func(enc map[string]any){
	func(enc map[string]any) { // stop encoding far ahead of the player, delete old segments
		enc["EnableThrottling"], enc["EnableSegmentDeletion"] = true, true
	},
}

// serverSteps are like configSteps, against the main server config
// (/System/Configuration), with their own count.
var serverSteps = []func(cfg map[string]any){
	func(cfg map[string]any) { // Refresh People looks people up on TMDb even with every library offline
		opts, _ := cfg["MetadataOptions"].([]any)
		var person map[string]any
		for _, o := range opts {
			if m, ok := o.(map[string]any); ok && m["ItemType"] == "Person" {
				person = m
			}
		}
		if person == nil {
			person = map[string]any{"ItemType": "Person"}
			opts = append(opts, person)
		}
		person["DisabledMetadataFetchers"], person["DisabledImageFetchers"] = []string{
			"TheMovieDb",
		}, []string{
			"TheMovieDb",
		}
		cfg["MetadataOptions"], cfg["PluginRepositories"] = opts, []any{}
	},
}

// HWAccels are the STREAMIQ_JELLYFIN_HWACCEL values ("" = none).
var HWAccels = []string{"", "nvenc"}

// hwAccel switches hardware transcoding. NVENC without a GPU in the container
// makes every transcode fail (no CPU fallback), so it is opt-in. Turning it
// off leaves the other fields alone: they do nothing without an accelerator.
func hwAccel(enc map[string]any, kind string) {
	if kind == "" {
		enc["HardwareAccelerationType"] = "none"
		return
	}
	for k, v := range map[string]any{
		"HardwareAccelerationType":       kind,
		"HardwareDecodingCodecs":         []string{"h264", "hevc", "mpeg2video", "vc1", "vp8", "vp9", "av1"},
		"EnableDecodingColorDepth10Hevc": true, "EnableDecodingColorDepth10Vp9": true,
		"EnableDecodingColorDepth10HevcRext": false, "EnableDecodingColorDepth12HevcRext": false,
		"EnableEnhancedNvdecDecoder": true, "EnableHardwareEncoding": true,
		"AllowHevcEncoding": false, "AllowAv1Encoding": false, // the browser may not play what comes out
		"EnableTonemapping": true,
		"EncoderPreset":     "fast", // "auto" is NVENC's lowest quality (p1)
	} {
		enc[k] = v
	}
}

// configure applies pending configSteps and serverSteps and a changed HWAccel to a Jellyfin
// the gateway set up, as its stored admin. A failure (e.g. the user changed
// that password) shows on the page and is retried next poll; playback runs on
// the viewer token either way.
func (s *Setup) configure(ctx context.Context) {
	s.vmu.Lock()
	defer s.vmu.Unlock()
	s.mu.Lock()
	c := s.creds
	s.mu.Unlock()
	if c.Token == "" || !c.managed() ||
		(c.ConfigSteps >= len(configSteps) && c.ServerSteps >= len(serverSteps) && c.HWAccel == s.HWAccel) {
		return
	}
	if err := s.applyConfig(ctx, c); err != nil {
		s.setErr("Jellyfin settings: " + err.Error())
		slog.Error("gateway: Jellyfin settings not applied", "err", err)
		return
	}
	s.setErr("")
	slog.Info(
		"gateway: applied Jellyfin settings",
		"steps",
		len(configSteps),
		"serverSteps",
		len(serverSteps),
		"hwaccel",
		s.HWAccel,
	)
}

func (s *Setup) applyConfig(ctx context.Context, c Creds) error {
	admin, err := s.signIn(ctx, c.User, c.Password)
	if err != nil {
		return err
	}
	defer s.logout(ctx, admin)
	if c.ServerSteps < len(serverSteps) {
		if err := s.edit(ctx, admin, "/System/Configuration", serverSteps[c.ServerSteps:]); err != nil {
			return err
		}
		s.mu.Lock()
		cur := s.creds // a page login may have replaced the token meanwhile
		s.mu.Unlock()
		cur.ServerSteps = len(serverSteps)
		if err := s.save(cur); err != nil {
			return err
		}
	}
	steps := configSteps[min(c.ConfigSteps, len(configSteps)):]
	if c.HWAccel != s.HWAccel {
		steps = append(steps[:len(steps):len(steps)], func(enc map[string]any) { hwAccel(enc, s.HWAccel) })
	}
	if len(steps) == 0 {
		return nil
	}
	if err := s.edit(ctx, admin, "/System/Configuration/encoding", steps); err != nil {
		return err
	}
	s.mu.Lock()
	c = s.creds
	s.mu.Unlock()
	c.ConfigSteps, c.HWAccel = len(configSteps), s.HWAccel
	return s.save(c)
}

// edit round-trips the whole config object at path through steps, like the
// viewer policy: fields this code doesn't know survive.
func (s *Setup) edit(ctx context.Context, admin, path string, steps []func(map[string]any)) error {
	var cfg map[string]any
	if err := s.call(ctx, "GET", path, admin, "", &cfg); err != nil {
		return err
	}
	for _, step := range steps {
		step(cfg)
	}
	b, _ := json.Marshal(cfg)
	return s.call(ctx, "POST", path, admin, string(b), nil)
}
