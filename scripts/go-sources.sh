#!/usr/bin/env bash
# The repo's Go source files, one path per line, for check-file-size.sh and check-comments.sh:
# tracked and untracked-but-not-ignored, so a new top-level Go directory needs no edit.
# Tests and generated files (drop-generated.sh) are left out.
set -euo pipefail
cd "$(dirname "$0")/.."

files=$(git ls-files --cached --others --exclude-standard -- '*.go' ':!:*_test.go' |
  while read -r f; do [ ! -e "$f" ] || echo "$f"; done | sort -u)
[ -n "$files" ] || { echo "go-sources: no Go files found" >&2; exit 2; }
echo "$files" | bash scripts/drop-generated.sh
