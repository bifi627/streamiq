#!/usr/bin/env bash
# /code-review level and merge-risk floor of a change for the agent review.
# Prints `<level> <floor> <why>`: level = xhigh | high | low, floor = 0..10, why = the
# rule that set the floor.
# The one place both rules live (the agent-review skill runs this instead of
# judging them); change the lists here.
#
#   bash scripts/review-level.sh [PR number]    # no number = this branch vs origin/main
#
# What the levels do (Claude Code 2.1.x; `medium` runs the same recipe as `high`,
# so it is not used): low = one read of the diff, no full-file reads; high = 8
# angles; xhigh = 10 angles plus a sweep for gaps, about 3.5x the time of high.
#
# Floor = the lowest merge risk the reviewer may give (it may go higher, with a
# reason): 0 docs only, 1 frontend or e2e only, 2 anything else, 4 gateway/** but its
# tests (what next-gateway-version.sh releases to installed gateways), 6 a `!` PR
# title, 7 a crown-jewel path. No device:* floor: those PRs stay draft until the
# owner's device test, so that gate already covers them.
set -euo pipefail

# xhigh: a changed file is under one of these paths (the crown jewels). Paths, not
# topics: e.g. gateway/internal/jellyfin/ deals with credentials and is still `high`.
XHIGH='
backend/src/StreamIq.Api/Data/
backend/src/StreamIq.Api/Auth/
backend/src/StreamIq.Api/Features/Broker/
backend/src/StreamIq.Api/Features/Gateways/
gateway/internal/tunnel/
gateway/internal/pairing/
gateway/internal/identity/
gateway/internal/localpage/
gateway/install/install.sh
gateway/install/install.ps1
.github/workflows/
'
# low: docs only (docs/ and *.md; the agent's own rules, CLAUDE.md and .claude/, are
# not docs). Everything else: high, however small.

if [ $# -gt 0 ]; then
  files=$(gh pr diff "$1" --name-only)
  title=$(gh pr view "$1" --json title --jq .title)
else
  git fetch -q origin
  files=$(git diff --name-only origin/main...HEAD)
  title=$(gh pr view --json title --jq .title 2>/dev/null) ||
    echo "review-level: no PR for this branch, the \`!\` floor is not checked" >&2
fi
[ -n "$files" ] || { echo "review-level: empty diff" >&2; exit 1; }

level=low floor=0 why=docs
raise() { if [ "$1" -gt "$floor" ]; then floor=$1 why=$2; fi; }
while IFS= read -r f; do
  for p in $XHIGH; do
    case "$f" in "$p"*) level=xhigh; raise 7 crown-jewel ;; esac
  done
  case "$f" in
    CLAUDE.md | .claude/*) [ $level = xhigh ] || level=high ;;
    docs/* | *.md) ;;
    *) [ $level = xhigh ] || level=high ;;
  esac
  case "$f" in
    gateway/*_test.go) raise 2 other ;;
    gateway/*) raise 4 gateway-release ;;
    frontend/* | e2e/*) raise 1 frontend ;;
    CLAUDE.md | .claude/*) raise 2 other ;;
    docs/* | *.md) ;;
    *) raise 2 other ;;
  esac
done <<<"$files"

# `type!:` / `type(scope)!:` marks a breaking change (same pattern as next-gateway-version.sh).
[[ ${title:-} =~ ^[a-zA-Z]+(\([^\)]*\))?!: ]] && raise 6 breaking-title
echo "$level $floor $why"
