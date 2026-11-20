#!/usr/bin/env bash
# Holds the comment rule (CLAUDE.md "Comments") to its baseline, per file and check:
#   refs  = comment lines citing an issue number outside the allowed forms:
#           a nolint / oxlint-disable line, TODO(#N), quirk(#N)
#   ratio = comment lines of a source file over 20 non-blank lines that is more than 30 % comments
# Counts must equal scripts/comment-baseline.txt (a missing line = 0): above it fails (new
# comments), below it fails too, so a cleanup lowers its line. --write-baseline rewrites the file.
# ponytail: line-based, no parser; a string holding " //" or " #" reads as a comment.
set -euo pipefail
cd "$(dirname "$0")/.."

baseline=scripts/comment-baseline.txt
for p in frontend/src gateway backend/src scripts .github/workflows gateway/.golangci.yml; do
  [ -e "$p" ] || { echo "check-comments: $p missing" >&2; exit 2; }
done

files=$( {
  find frontend/src -name '*.ts' -o -name '*.tsx' | grep -vE '\.test\.tsx?$'
  find gateway -name '*.go' -not -name '*_test.go'
  find backend/src -name '*.cs' -not -path '*/obj/*' -not -path '*/bin/*' -not -path '*/Migrations/*' \
    -not -name '*.Designer.cs' -not -name '*.g.cs'
  ls scripts/*.sh scripts/*.ps1 .github/workflows/*.yml gateway/.golangci.yml
} | sort)

# "<path> <check> <count>" per hit
# shellcheck disable=SC2086 # one path per line, none with spaces
current=$(awk '
  function ref(c) {
    if (c ~ /nolint|oxlint-disable/) return 0
    gsub(/(TODO|quirk)\(#[0-9]+\)/, "", c)
    return c ~ /#[0-9]/
  }
  function flush() {
    if (f == "") return
    if (refs) print f, "refs", refs
    if (!hash && nb > 20 && com * 10 > nb * 3) print f, "ratio", com
  }
  FNR == 1 { flush(); f = FILENAME; hash = f ~ /\.(sh|ps1|yml)$/; refs = nb = com = blk = 0 }
  { l = $0; gsub(/^[ \t\r]+|[ \t\r]+$/, "", l) }
  l == "" { next }
  { nb++ }
  hash {
    if (match(l, /(^|[ \t])#([^0-9]|$)/)) refs += ref(substr(l, RSTART))
    next
  }
  blk {
    com++; refs += ref(l)
    if (l ~ /\*\//) blk = 0
    next
  }
  l ~ /^(\/\/|\/\*|\{\/\*)/ {
    com++; refs += ref(l)
    if (l ~ /^\{?\/\*/ && l !~ /\*\//) blk = 1
    next
  }
  match(l, /[ \t](\/\/|\/\*)/) { refs += ref(substr(l, RSTART)); if (substr(l, RSTART + 1, 2) == "/*" && l !~ /\*\//) blk = 1 }
  END { flush() }' $files | LC_ALL=C sort)

if [ "${1-}" = --write-baseline ]; then
  { echo "# Comment-rule hits allowed today (scripts/check-comments.sh). One line per path and check:"
    echo "# <path> <refs|ratio> <count>. Cleanups lower or drop lines; never raise one."
    printf '%s\n' "$current"
  } > "$baseline"
  echo "wrote $baseline"
  exit 0
fi
[ -e "$baseline" ] || { echo "check-comments: $baseline missing" >&2; exit 2; }

bad=$(printf '%s\n' "$current" | awk -v list="$baseline" '
  FILENAME == list { if ($0 !~ /^#/ && NF == 3) base[$1 " " $2] = $3; next }
  NF == 3 { cur[$1 " " $2] = $3 }
  END {
    for (k in cur) if (cur[k] > base[k] + 0) print k ": " cur[k] ", baseline " base[k] + 0
    for (k in base) if (cur[k] + 0 < base[k]) print k ": " cur[k] + 0 ", baseline " base[k] " (lower its line in " list ")"
  }' "$baseline" -)

if [ -n "$bad" ]; then
  echo "$bad" | LC_ALL=C sort >&2
  echo "Comment rule: CLAUDE.md \"Comments\". refs = an issue number outside nolint/oxlint-disable/TODO(#N)/quirk(#N);" >&2
  echo "ratio = a file over 30 % comment lines. Below baseline: run bash $0 --write-baseline." >&2
  exit 1
fi
echo "comments: no file above its baseline (refs, ratio)"
