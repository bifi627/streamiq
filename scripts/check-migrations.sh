#!/usr/bin/env bash
# squawk (pinned image, config in .squawk.toml) on the migrations after $applied.
# Those up to it already ran in production, so they are never edited and not linted
# (they lack lock/statement timeouts).
set -euo pipefail
cd "$(dirname "$0")/.."

applied=0007 # bump only in a PR after the newer ones ran in production, never in the one adding them
img=ghcr.io/sbdchd/squawk:2.72.0
files=()
for f in api/migrations/*.sql; do
  n=$(basename "$f")
  (( 10#${n%%_*} > 10#$applied )) && files+=("$f")
done
if [ ${#files[@]} -eq 0 ]; then
  echo "check-migrations: no migration after ${applied}_*, nothing to lint"
  exit 0
fi
MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD:/data" "$img" "${files[@]}"
