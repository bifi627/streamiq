#!/usr/bin/env bash
# Fails when a STREAMIQ_* env var, a gateway API route or a message type in code is missing from the docs (#488):
#   gateway/ (Go + install scripts)  -> a row of the gateway.env table in docs/install.md
#   api/, scripts/                   -> named somewhere in docs/ (docs/superpowers is history: not counted)
#   "/streamiq/..." in gateway Go    -> docs/protocol.md
#   message `type`s (tstype) in protocol/, gateway/internal/sessions, gateway/internal/screen -> docs/protocol.md, both ways
# Tracked files only (git grep), so a local gateway.env, state dir or draft can't make check.sh and CI disagree.
# Test-only code (_test.go, testdata/) is skipped; test/dev-only names go on scripts/docs-drift-allowlist.txt.
# ponytail: grep sees names, not meaning; whether the doc is right stays the review's job.
set -euo pipefail
cd "$(dirname "$0")/.."

allowlist=scripts/docs-drift-allowlist.txt
for f in "$allowlist" docs/install.md docs/protocol.md; do
  [ -f "$f" ] || { echo "check-docs-drift: $f missing" >&2; exit 2; }
done

# names <paths...>: the STREAMIQ_* names found, sorted, minus the allowlist. A name ends in a letter
# or digit, so a wildcard like ICE_* in code reads as a name of its own and fails: it documents nothing.
names() {
  local rc=0 hits
  hits=$(git grep -IhoE 'STREAMIQ_[A-Z0-9_]*[A-Z0-9]' -- "$@" ':!*_test.go' ':!*/testdata/*') || rc=$?
  [ "$rc" -le 1 ] || exit "$rc"
  printf '%s\n' "$hits" | sort -u | awk -v list="$allowlist" '
    FILENAME == list { sub(/#.*/, ""); gsub(/[ \t]/, ""); if ($0 != "") ok[$0]; next }
    $0 != "" && !($0 in ok)' "$allowlist" -
}

fail=0
gw=$(names gateway); other=$(names api scripts) # assignments, so a grep error aborts (set -e)
# shellcheck disable=SC2016 # the backticks are literal markdown, not a command substitution
table=$(grep -oE '^\| `STREAMIQ_[A-Z0-9_]+`' docs/install.md | tr -d '|` ' || true)
for n in $gw; do
  grep -qxF "$n" <<<"$table" || { echo "  $n: read under gateway/, no row in the gateway.env table (docs/install.md)" >&2; fail=1; }
done
for n in $other; do
  git grep -qw "$n" -- docs ':!docs/superpowers' || { echo "  $n: read in api/ or scripts/, named nowhere in docs/" >&2; fail=1; }
done

rc=0; routes=$(git grep -hoE '"/streamiq/[^"]+"' -- 'gateway/*.go' ':!*_test.go' ':!*/testdata/*' | tr -d '"' | sort -u) || rc=$?
[ "$rc" -le 1 ] || exit "$rc"
for r in $routes; do
  # Not followed by more path or a wildcard: /streamiq/clients must not pass on /streamiq/clients/remove
  # or /streamiq/clients* alone.
  grep -qE "${r}([^A-Za-z0-9/_*.-]|$)" docs/protocol.md || { echo "  $r: gateway route missing from docs/protocol.md" >&2; fail=1; }
done

# Message types: the tstype literals on `json:"type"` fields vs the types docs/protocol.md shows, per set.
# The doc side: the handshake = its step table, screen commands = their table, broker = the rest of the doc.
code_types() {
  local rc=0 hits
  hits=$(git grep -h 'json:"type".*tstype:' -- "$1" ':!*_test.go') || rc=$?
  [ "$rc" -le 1 ] || exit "$rc"
  printf '%s\n' "$hits" | grep -oE "tstype:\"[^\"]*\"" | grep -oE "'[a-z]+'" | tr -d "'" | sort -u || true
}
doc_types() { grep -oE '"?type"?: ?"[a-z]+"(\|"[a-z]+")*' | grep -oE '"[a-z]+"' | grep -vx '"type"' | tr -d '"' | sort -u || true; }
handshake_row='^\| [0-9]+ \| (gateway|browser) → '
screen_row='^\| `\{"type"'
# compare <set> <code dir> <doc types>
compare() {
  local code; code=$(code_types "$2")
  [ -n "$code" ] || { echo "check-docs-drift: no message types found in $2" >&2; exit 2; }
  while read -r t; do [ -n "$t" ] || continue; echo "  $1 message type \"$t\": in $2, not in docs/protocol.md" >&2; fail=1; done < <(comm -23 <(echo "$code") <(echo "$3"))
  while read -r t; do [ -n "$t" ] || continue; echo "  $1 message type \"$t\": in docs/protocol.md, not in $2" >&2; fail=1; done < <(comm -13 <(echo "$code") <(echo "$3"))
}
compare broker protocol "$(grep -vE "$handshake_row|$screen_row" docs/protocol.md | doc_types)"
compare handshake gateway/internal/sessions "$(grep -E "$handshake_row" docs/protocol.md | doc_types)"
compare screen gateway/internal/screen "$(grep -E "$screen_row" docs/protocol.md | doc_types)"

if [ "$fail" -ne 0 ]; then
  echo "Docs drift: document the above in the same diff, or, for a test/dev-only env var, add it to" >&2
  echo "$allowlist with a reason (a review trigger: call it out in the PR)." >&2
  exit 1
fi
echo "docs drift: every STREAMIQ_* env var, gateway route and message type is documented"
