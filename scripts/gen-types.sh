#!/usr/bin/env bash
# The web app's TypeScript (frontend/src/generated/) from the Go wire types: scripts/tygo.yaml.
# --check: fail when that differs from what is committed (check.sh, CI).
# tygo is pinned and run through go run, so it stays out of go.mod (docs/tools.md).
set -euo pipefail
cd "$(dirname "$0")/.."

out=frontend/src/generated
rm -rf "$out"
go run github.com/gzuidhof/tygo@v0.2.21 generate --config scripts/tygo.yaml
if [ "${1-}" = --check ] && [ -n "$(git status --porcelain -- "$out")" ]; then
  git status --short -- "$out"
  git diff -- "$out"
  echo "gen-types: $out is stale: run bash scripts/gen-types.sh and commit the result" >&2
  exit 1
fi
