#!/usr/bin/env bash
# Next gateway release version (#274). Run from the repo root of a checkout with full history + tags, Go installed:
#   next-gateway-version.sh      → the version to release HEAD as, or nothing if there's nothing to release
#   next-gateway-version.sh --test  → self-check against a scratch repo (check.sh + CI)
# Base = the highest stable tag gateway-vX.Y.Z (semver sort; prereleases ignored).
# Nothing to release: HEAD is already in the base release (an older commit, a re-run), or
# nothing the gateway builds with changed since it: gateway/ (tests aside), the repo's packages it
# imports from outside gateway/ (`go list`), and in go.mod/go.sum only the modules it builds with
# and the go/toolchain lines (the Go API shares the module). So it releases main's state,
# not one commit: a change whose own run never released (red CI, cancelled, [skip release]) goes
# out with the next release.
# Bump: a breaking subject (`type!:` / `type(scope)!:`) on any gateway commit since the
# base bumps the minor, else the patch. The major never changes here: the owner pushes
# gateway-vN.0.0 by hand and this follows it.
set -euo pipefail

# The gateway's build inputs from go.mod in tree $1, for every OS it's released for:
# its modules (path, version, replacement) and the go/toolchain lines.
gwmods() {
  local os
  for os in linux darwin windows; do
    CGO_ENABLED=0 GOOS=$os go list -C "$1/gateway" -deps \
      -f '{{with .Module}}{{if not .Main}}{{.Path}} {{.Version}}{{with .Replace}} => {{.Path}} {{.Version}}{{end}}{{end}}{{end}}' ./...
  done
  grep -E '^(go|toolchain) ' "$(go env -C "$1/gateway" GOMOD)"
}

# Pathspecs of the repo's packages outside gateway/ that the gateway imports (protocol/, …).
gwpkgs() {
  local mod os
  mod=$(go list -C gateway -m)
  for os in linux darwin windows; do
    CGO_ENABLED=0 GOOS=$os go list -C gateway -deps -f '{{with .Module}}{{if .Main}}{{$.ImportPath}}{{end}}{{end}}' ./...
  done | sed -n "s#^$mod/##p" | { grep -v '^gateway/' || true; } | sort -u | sed 's#.*#:(glob)&/*#'
}

next() {
  local base ma mi pa log t pk paths=(gateway/ ':(exclude,glob)**/*_test.go')
  base=$(git tag -l 'gateway-v*' | sed 's#^gateway-v##' | { grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' || true; } | sort -V | tail -1)
  [ -n "$base" ] && git merge-base --is-ancestor HEAD "gateway-v$base" && return 0
  pk=$(gwpkgs)
  [ -z "$pk" ] || mapfile -t -O "${#paths[@]}" paths <<<"$pk"
  if [ -z "$base" ]; then
    base=0.0.0 log=$(git log --format=%s HEAD -- "${paths[@]}" go.mod go.sum)
  else
    if ! git diff --quiet "gateway-v$base" HEAD -- go.mod go.sum; then
      t=$(mktemp -d)
      git archive "gateway-v$base" | tar -x -C "$t"
      # ponytail: go.mod/go.sum commits all count once the set differs, so an API-only `type!:` one
      # in the same window bumps the minor too; per-commit `go list` if that ever matters.
      [ "$(gwmods "$t" | sort -u)" = "$(gwmods . | sort -u)" ] || paths+=(go.mod go.sum)
      rm -rf "$t"
    fi
    git diff --quiet "gateway-v$base" HEAD -- "${paths[@]}" && return 0
    log=$(git log --format=%s "gateway-v$base..HEAD" -- "${paths[@]}")
  fi
  IFS=. read -r ma mi pa <<<"$base"
  if grep -qE '^[a-zA-Z]+(\([^)]*\))?!:' <<<"$log"; then echo "$((10#$ma)).$((10#$mi + 1)).0"
  else echo "$((10#$ma)).$((10#$mi)).$((10#$pa + 1))"; fi
}

if [ "${1:-}" = --test ]; then
  d=$(mktemp -d) && trap 'rm -rf "$d"' EXIT && cd "$d"
  export GOWORK=off GOTOOLCHAIN=local GOPROXY=off
  g() { git -c core.autocrlf=false -c user.name=t -c user.email=t@t -c commit.gpgsign=false -c tag.gpgsign=false "$@"; }
  w() { mkdir -p "$(dirname "$1")"; printf '%s\n' "$2" >"$1"; }
  # appends a line to $1 (a Go comment in a .go file, created with its package clause) and commits it as $2
  c() {
    mkdir -p "$(dirname "$1")"
    case $1 in *.go) [ -e "$1" ] || echo "package $(basename "$(dirname "$1")")" >"$1"; echo "// $2" >>"$1" ;; *) echo "$2" >>"$1" ;; esac
    g add -A; g commit -qm "$2"
  }
  m() { sed -i "$1" go.mod; g commit -qam "$2"; } # edits go.mod with sed script $1, commits as $2
  want() { got=$(next); [ "$got" = "$1" ] || { echo "FAIL: $2: got '$got', want '$1'" >&2; exit 1; }; }
  g init -q
  # module m: the gateway imports gwdep and protocol/, api/ imports apidep; both deps are local
  # replacements, so a version bump in go.mod needs no download
  w go.mod "module example.com/m
go 1.21
require (
	example.com/gwdep v1.0.0
	example.com/apidep v1.0.0
)
replace example.com/gwdep => ./_deps/gwdep
replace example.com/apidep => ./_deps/apidep"
  for p in gwdep apidep; do w _deps/$p/go.mod "module example.com/$p"; w _deps/$p/$p.go "package $p"; done
  w protocol/p.go "package protocol"
  w api/api.go 'package api
import _ "example.com/apidep"'
  w gateway/gateway.go 'package gateway
import (
	_ "example.com/gwdep"
	_ "example.com/m/protocol"
)'
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
  g tag gateway-v1.0.1; m 's/apidep v1.0.0/apidep v1.0.1/' "chore(deps): api only"
                                            want "" "a module only the API builds with"
  c api/api.go "feat(api): x"; c protocol/p_test.go "test: protocol"
                                            want "" "API code, a test of an imported package"
  m 's/gwdep v1.0.0/gwdep v1.0.1/' "fix(deps): gateway dep"
                                            want 1.0.2 "a module the gateway builds with"
  g tag gateway-v1.0.2; m 's/^go 1.21$/go 1.22/' "chore: go line"
                                            want 1.0.3 "the go line"
  g tag gateway-v1.0.3; c protocol/p.go "fix(protocol): wire"
                                            want 1.0.4 "a repo package the gateway imports outside gateway/"
  # a stable tag off main (e.g. a PR branch head before its squash merge) must not block
  g checkout -q -b side HEAD~1; c gateway/s.go "fix: side"; g tag gateway-v1.0.08; g checkout -q -
                                            want 1.0.9 "tag off main doesn't block; decimal, not octal"
  g checkout -q HEAD~1;                     want "" "older commit than the release (a re-run)"
  echo "next-gateway-version: ok"
  exit
fi

next
