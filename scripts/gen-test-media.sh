#!/usr/bin/env bash
# Generate deterministic, license-free test media into dev-media/ (gitignored).
# Requires ffmpeg. Runs in Git Bash, WSL, devcontainer, CI.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dev-media

# Plays-everywhere baseline (H.264 + AAC, MP4)
ffmpeg -y -f lavfi -i "testsrc=duration=30:size=1280x720:rate=30" \
  -f lavfi -i "sine=frequency=440:duration=30" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest \
  dev-media/h264-aac.mp4

# Forces Jellyfin to transcode for a browser (HEVC + AC3, MKV)
ffmpeg -y -f lavfi -i "testsrc=duration=30:size=1280x720:rate=30" \
  -f lavfi -i "sine=frequency=440:duration=30" \
  -c:v libx265 -pix_fmt yuv420p -c:a ac3 -shortest \
  dev-media/hevc-ac3.mkv

# Long clip for seek testing (~10 min, H.264 + AAC)
ffmpeg -y -f lavfi -i "testsrc=duration=600:size=1280x720:rate=30" \
  -f lavfi -i "sine=frequency=440:duration=600" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest \
  dev-media/h264-aac-long.mp4

# Two audio tracks (#109): English 440 Hz, German 880 Hz, to hear a switch.
ffmpeg -y -f lavfi -i "testsrc=duration=120:size=1280x720:rate=30" \
  -f lavfi -i "sine=frequency=440:duration=120" \
  -f lavfi -i "sine=frequency=880:duration=120" \
  -map 0:v -map 1:a -map 2:a -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest \
  -metadata:s:a:0 language=eng -metadata:s:a:1 language=deu \
  dev-media/h264-two-audio.mp4

# 1080p + subtitle fixture for the Checkpoint-1 "sustained 1080p + subs over the
# away path" test. CBR ~6 Mbps (a realistic 1080p streaming bitrate) — testsrc is
# highly compressible, so without a forced bitrate it'd encode to ~1 Mbps and
# under-test the network. 6 min so seek-to-5:00 lands inside the clip.
ffmpeg -y -f lavfi -i "testsrc=duration=360:size=1920x1080:rate=30" \
  -f lavfi -i "sine=frequency=440:duration=360" \
  -c:v libx264 -pix_fmt yuv420p -b:v 6M -minrate 6M -maxrate 6M -bufsize 6M \
  -x264-params "nal-hrd=cbr:force-cfr=1" -c:a aac -shortest \
  dev-media/h264-1080p-subs.mp4

# Sidecar subtitle — Jellyfin indexes a matching-basename .srt as an external
# subtitle stream (SubtitleMethod=Hls then delivers it as a WebVTT rendition).
# Cues span the clip, incl. one right after the 5:00 seek target.
cat > dev-media/h264-1080p-subs.en.srt <<'SRT'
1
00:00:02,000 --> 00:00:09,000
streamiq subtitle test — if you can read this, subs survive the tunnel

2
00:00:30,000 --> 00:00:36,000
00:30 — sustained 1080p over the away path

3
00:01:00,000 --> 00:01:06,000
01:00 — still streaming

4
00:02:00,000 --> 00:02:06,000
02:00 — halfway-ish

5
00:04:00,000 --> 00:04:06,000
04:00 — approaching the seek target

6
00:05:00,000 --> 00:05:08,000
05:00 — subtitle visible right after the seek

7
00:05:30,000 --> 00:05:36,000
05:30 — near the end
SRT

echo "Test media written to dev-media/"
