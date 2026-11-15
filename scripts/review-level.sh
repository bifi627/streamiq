#!/usr/bin/env bash
# /code-review level and merge-risk floor of a change for the agent review.
# Prints two words: `<level> <floor>`, level = xhigh | high | low, floor = 0..10.
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
# reason): 0 docs only, 1 frontend or e2e only, 2 anything else, 4 gateway/** (auto-released
# to installed gateways), 6 a `!` PR title or a device:* label, 7 a crown-jewel path.
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
  meta=$(gh pr view "$1" --json title,labels --jq '.title, (.labels[].name)')
else
  git fetch -q origin
  files=$(git diff --name-only origin/main...HEAD)
  meta=$(gh pr view --json title,labels --jq '.title, (.labels[].name)' 2>/dev/null || true)
fi
[ -n "$files" ] || { echo "review-level: empty diff" >&2; exit 1; }

level=low floor=0
raise() { [ "$1" -gt "$floor" ] && floor=$1 || true; }
while IFS= read -r f; do
  for p in $XHIGH; do
    case "$f" in "$p"*) level=xhigh; raise 7 ;; esac
  done
  case "$f" in
    CLAUDE.md | .claude/*) [ $level = xhigh ] || level=high; raise 2 ;;
    docs/* | *.md) ;;
    frontend/* | e2e/*) [ $level = xhigh ] || level=high; raise 1 ;;
    gateway/*) [ $level = xhigh ] || level=high; raise 4 ;;
    *) [ $level = xhigh ] || level=high; raise 2 ;;
  esac
done <<<"$files"

# Title is the first line: `type!:` / `type(scope)!:` marks a breaking change.
head -n1 <<<"$meta" | grep -qE '^[a-z]+(\([^)]*\))?!:' && raise 6
tail -n +2 <<<"$meta" | grep -q '^device:' && raise 6
echo "$level $floor"
