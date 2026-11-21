#!/usr/bin/env bash
# The repo's Go source files, one path per line, for check-file-size.sh and check-comments.sh:
# tracked and untracked-but-not-ignored, so a new top-level Go directory needs no edit.
# Tests and generated files (Go's "Code generated … DO NOT EDIT." header) are left out.
set -euo pipefail
cd "$(dirname "$0")/.."

files=$(git ls-files --cached --others --exclude-standard -- '*.go' ':!:*_test.go' |
  while read -r f; do [ ! -e "$f" ] || echo "$f"; done | sort -u)
[ -n "$files" ] || { echo "go-sources: no Go files found" >&2; exit 2; }
# shellcheck disable=SC2086 # one path per line, none with spaces
# exit 1 = "nothing listed" or, before GNU grep 3.5, "something listed"; 2 = an error
grep -LE '^// Code generated .* DO NOT EDIT\.$' $files || [ $? = 1 ]
