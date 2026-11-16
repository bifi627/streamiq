#!/bin/sh
# A small TV series fixture: "StreamIQ Test Series", 2 seasons × 2 episodes of
# 10 s, in Jellyfin's Series/Season NN/Series SNNENN layout under $1. Plain sh:
# the e2e stack runs it inside the Jellyfin container (FFMPEG = its ffmpeg).
#   sh scripts/gen-test-series.sh <dir>
set -eu
D="$1/StreamIQ Test Series"
for s in 1 2; do
  mkdir -p "$D/Season 0$s"
  for e in 1 2; do
    "${FFMPEG:-ffmpeg}" -loglevel error -y \
      -f lavfi -i "testsrc=duration=10:size=640x360:rate=30" \
      -f lavfi -i "sine=frequency=440:duration=10" \
      -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest \
      "$D/Season 0$s/StreamIQ Test Series S0${s}E0$e.mp4"
  done
done
