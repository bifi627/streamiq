#!/usr/bin/env bash
# A count above its baseline line (missing line = 0) fails. Cleanups lower their lines by hand.
# TS issue refs are oxlint's (streamiq/no-low-value-comments); CSS and the other stacks are here.
# ponytail: line-based, no parser; a string holding " //" or " #" reads as a comment.
set -euo pipefail
cd "$(dirname "$0")/.."

baseline=scripts/comment-baseline.txt
for p in frontend/src gateway api backend/src scripts .github/workflows .golangci.yml .editorconfig; do
  [ -e "$p" ] || { echo "check-comments: $p missing" >&2; exit 2; }
done

go=$(bash scripts/go-sources.sh)
files=$( {
  echo "$go"
  find frontend/src -name '*.ts' -o -name '*.tsx' -o -name '*.css' | grep -vE '\.test\.tsx?$'
  find backend/src -name '*.cs' -not -path '*/obj/*' -not -path '*/bin/*' -not -path '*/Migrations/*' \
    -not -name '*.Designer.cs' -not -name '*.g.cs'
  ls scripts/*.sh scripts/*.ps1 scripts/*.sql .github/workflows/*.yml .golangci.yml .editorconfig
} | sort)

# shellcheck disable=SC2086 # one path per line, none with spaces
current=$(awk '
  function ref(c) {
    if (c ~ /nolint|oxlint-disable/) return 0
    gsub(/(TODO|quirk)\(#[0-9]+\)/, "", c)
    return c ~ /#[0-9]/
  }
  function flush() {
    if (f == "") return
    if (refs && f !~ /\.tsx?$/) print f, "refs", refs
    if (!hash && !sql && nb > 20 && com * 10 > nb * 3) print f, "ratio", com
  }
  FNR == 1 { flush(); f = FILENAME; hash = f ~ /(\.(sh|ps1|yml)|editorconfig)$/; sql = f ~ /\.sql$/; refs = nb = com = blk = 0 }
  { l = $0; gsub(/^[ \t\r]+|[ \t\r]+$/, "", l) }
  l == "" { next }
  { nb++ }
  hash {
    if (match(l, /(^|[ \t])#/)) refs += ref(substr(l, RSTART))
    next
  }
  sql {
    if (match(l, /(^|[ 	])--/)) refs += ref(substr(l, RSTART))
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
  { echo "# <path> <refs|ratio> <count>: lower or drop a line, never raise one."
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
  }' "$baseline" -)

if [ -n "$bad" ]; then
  echo "$bad" | LC_ALL=C sort >&2
  echo "Comment rule: CLAUDE.md \"Comments say what the code can't\". refs = an issue number outside nolint/oxlint-disable/TODO(#N)/quirk(#N);" >&2
  echo "ratio = a file over 30 % comment lines." >&2
  exit 1
fi
echo "comments: no file above its baseline (refs, ratio)"
