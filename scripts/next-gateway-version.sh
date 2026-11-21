#!/usr/bin/env bash
# Next gateway release version (#274). Run in a checkout with full history + tags:
#   next-gateway-version.sh      → the version to release HEAD as, or nothing if there's nothing to release
#   next-gateway-version.sh --test  → self-check against a scratch repo (check.sh + CI)
# Base = the highest stable tag gateway-vX.Y.Z (semver sort; prereleases ignored).
# Nothing to release: HEAD is already in the base release (an older commit, a re-run),
# or gateway/ (tests aside) and go.mod/go.sum are unchanged since it. So it releases main's state, not one
# commit: a change whose own run never released (red CI, cancelled, [skip release]) goes
# out with the next release.
# Bump: a breaking subject (`type!:` / `type(scope)!:`) on any gateway commit since the
# base bumps the minor, else the patch. The major never changes here: the owner pushes
# gateway-vN.0.0 by hand and this follows it.
set -euo pipefail

next() {
  local base ma mi pa log paths=(gateway/ go.mod go.sum ':(exclude,glob)gateway/**/*_test.go')
  base=$(git tag -l 'gateway-v*' | sed 's#^gateway-v##' | { grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' || true; } | sort -V | tail -1)
  if [ -n "$base" ]; then
    git merge-base --is-ancestor HEAD "gateway-v$base" && return 0
    git diff --quiet "gateway-v$base" HEAD -- "${paths[@]}" && return 0
    log=$(git log --format=%s "gateway-v$base..HEAD" -- "${paths[@]}")
  else
    base=0.0.0 log=$(git log --format=%s HEAD -- "${paths[@]}")
  fi
  IFS=. read -r ma mi pa <<<"$base"
  if grep -qE '^[a-zA-Z]+(\([^)]*\))?!:' <<<"$log"; then echo "$((10#$ma)).$((10#$mi + 1)).0"
  else echo "$((10#$ma)).$((10#$mi)).$((10#$pa + 1))"; fi
}

if [ "${1:-}" = --test ]; then
  d=$(mktemp -d) && trap 'rm -rf "$d"' EXIT && cd "$d"
  g() { git -c core.autocrlf=false -c user.name=t -c user.email=t@t -c commit.gpgsign=false -c tag.gpgsign=false "$@"; }
  c() { mkdir -p "$(dirname "$1")"; echo "$2" >>"$1"; g add -A; g commit -qm "$2"; }
  want() { got=$(next); [ "$got" = "$1" ] || { echo "FAIL: $2: got '$got', want '$1'" >&2; exit 1; }; }
  g init -q
  c gateway/a.go "feat: first";             want 0.0.1 "no tag yet"
  g tag gateway-v0.0.9; g tag gateway-v0.0.10; want "" "HEAD already released"
  c frontend/x "fix: ui";                   want "" "no gateway change"
  c gateway/sub/a_test.go "test: only";     want "" "gateway tests only"
  c gateway/a.go "fix: gw";                 want 0.0.11 "semver sort, not string sort"
  c gateway/b.go "Feat!: break";            want 0.1.0 "breaking"
  c gateway/a.go "fix: later";              want 0.1.0 "breaking earlier since the base still counts"
  g tag gateway-v0.1.0; c frontend/x "feat!: ui only"; c gateway/a.go "fix: x"
                                            want 0.1.1 "a frontend break is not a gateway break"
  g tag gateway-v0.2.0-rc.1;                want 0.1.1 "prerelease ignored"
  g tag gateway-v1.0.0; c gateway/a.go "fix: y"; want 1.0.1 "hand-pushed major followed"
  g tag gateway-v1.0.1; c go.sum "fix(deps): bump"; want 1.0.2 "the root go.sum counts as a gateway change"
  # a stable tag off main (e.g. a PR branch head before its squash merge) must not block
  g checkout -q -b side HEAD~1; c gateway/s.go "fix: side"; g tag gateway-v1.0.08; g checkout -q -
                                            want 1.0.9 "tag off main doesn't block; decimal, not octal"
  g checkout -q HEAD~1;                     want "" "older commit than the release (a re-run)"
  echo "next-gateway-version: ok"
  exit
fi

next
