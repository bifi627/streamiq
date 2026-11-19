#!/usr/bin/env bash
# Fails a source file over 500 code lines (blank and comment-only lines skipped) in frontend/src,
# gateway and backend/src, unless scripts/file-size-allowlist.txt names it (#600). Tests, migrations
# and generated files don't count. An allowlisted file back under the limit fails too: drop its line.
# ponytail: line-based comment detection; a string line starting with // or /* counts as a comment.
set -euo pipefail
cd "$(dirname "$0")/.."

max=500
allowlist=scripts/file-size-allowlist.txt
# Fail closed: a missing input must not read as "no offenders".
for p in "$allowlist" frontend/src gateway backend/src; do
  [ -e "$p" ] || { echo "check-file-size: $p missing" >&2; exit 2; }
done

files=$( {
  find frontend/src -name '*.ts' -o -name '*.tsx' | grep -vE '\.test\.tsx?$'
  find gateway -name '*.go' -not -name '*_test.go'
  find backend/src -name '*.cs' -not -path '*/obj/*' -not -path '*/bin/*' -not -path '*/Migrations/*' \
    -not -name '*.Designer.cs' -not -name '*.g.cs'
} | sort)

# "<code lines> <path>" per file
# shellcheck disable=SC2086 # one path per line, none with spaces
counts=$(awk '
  FNR == 1 { if (f != "") print n, f; f = FILENAME; n = 0; blk = 0 }
  { l = $0; gsub(/^[ \t\r]+|[ \t\r]+$/, "", l) }
  blk { if (l !~ /\*\//) next; blk = 0; sub(/.*\*\//, "", l); gsub(/^[ \t]+/, "", l) }
  l == "" || l ~ /^\/\// || l ~ /^\{\/\*.*\*\/\}$/ { next }
  l ~ /^\/\*/ { if (l !~ /\*\//) { blk = 1; next }; r = l; sub(/^\/\*.*\*\//, "", r); if (r ~ /^[ \t]*$/) next }
  { n++ }
  END { if (f != "") print n, f }' $files)

bad=$(printf '%s\n' "$counts" | awk -v max="$max" -v list="$allowlist" '
  FILENAME == list { sub(/#.*/, ""); gsub(/[ \t]+$/, ""); if ($0 != "") ok[$0] = 1; next }
  $1 > max && !($2 in ok) { print "over " max ": " $2 " (" $1 " code lines)" }
  $1 <= max && ($2 in ok) { print "allowlisted but " $1 " code lines: " $2 " (remove its line from " list ")" }
  { seen[$2] = 1 }
  END { for (p in ok) if (!(p in seen)) print "allowlisted but not found: " p }' "$allowlist" -)

if [ -n "$bad" ]; then
  echo "$bad" >&2
  echo "Split the file along a real seam (#609). An allowlist line names the issue that removes it." >&2
  exit 1
fi
echo "file size: no source file over $max code lines outside the allowlist"
