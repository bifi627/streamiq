#!/usr/bin/env bash
# The repo's Go files, one path per line: tracked and untracked-but-not-ignored, so a new
# top-level Go directory needs no edit. By default (check-file-size.sh, check-comments.sh)
# tests and generated files (drop-generated.sh) are left out; --all keeps them (gofmt).
set -euo pipefail
cd "$(dirname "$0")/.."

files=$(git ls-files --cached --others --exclude-standard -- '*.go' |
  while read -r f; do [ ! -e "$f" ] || echo "$f"; done | sort -u)
[ -n "$files" ] || { echo "go-sources: no Go files found" >&2; exit 2; }
if [ "${1:-}" = --all ]; then
  echo "$files"
else
  echo "$files" | grep -v '_test\.go$' | bash scripts/drop-generated.sh
fi
