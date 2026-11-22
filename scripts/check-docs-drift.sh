#!/usr/bin/env bash
# Fails when a STREAMIQ_* env var or a gateway API route in code is missing from the docs (#488):
#   gateway/ (Go + install scripts)  -> a row of the gateway.env table in docs/install.md
#   api/, scripts/                   -> named somewhere in docs/ (docs/superpowers is history: not counted)
#   "/streamiq/..." in gateway Go    -> docs/protocol.md
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

if [ "$fail" -ne 0 ]; then
  echo "Docs drift: document the above in the same diff, or, for a test/dev-only env var, add it to" >&2
  echo "$allowlist with a reason (a review trigger: call it out in the PR)." >&2
  exit 1
fi
echo "docs drift: every STREAMIQ_* env var and gateway route is documented"
