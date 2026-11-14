#!/usr/bin/env bash
# /code-review level of a change for the agent review: prints xhigh | high | low.
# The one place this rule lives (the agent-review skill runs this instead of
# judging it); change the list here.
#
#   bash scripts/review-level.sh [PR number]    # no number = this branch vs origin/main
#
# What the levels do (Claude Code 2.1.x; `medium` runs the same recipe as `high`,
# so it is not used): low = one read of the diff, no full-file reads; high = 8
# angles; xhigh = 10 angles plus a sweep for gaps, about 3.5x the time of high.
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
else
  git fetch -q origin
  files=$(git diff --name-only origin/main...HEAD)
fi
[ -n "$files" ] || { echo "review-level: empty diff" >&2; exit 1; }

level=low
while IFS= read -r f; do
  for p in $XHIGH; do
    case "$f" in "$p"*) echo xhigh; exit 0 ;; esac
  done
  case "$f" in
    CLAUDE.md | .claude/*) level=high ;;
    docs/* | *.md) ;;
    *) level=high ;;
  esac
done <<<"$files"
echo "$level"
