#!/usr/bin/env bash
# Suggested /code-review level and risk label of a change for the agent review (#612).
# A suggestion, not a floor: the reviewer reads the diff and may go either way, with a
# reason (agent-review sections 2 and 5). This script only finds the facts.
#
#   bash scripts/review-level.sh [PR number]    # no number = this branch vs origin/main
#
# Prints `<level> <risk> <why>` on the first line (level = xhigh | high | low, risk =
# low | mid | critical, why = the rule that set the risk), then the evidence, one line
# each: `path: <file> (+added -removed)` for a crown-jewel path, `content: <file>:
# <pattern>` for an added line matching a risky pattern anywhere.
#
# What the levels do (Claude Code 2.1.x; `medium` runs the same recipe as `high`,
# so it is not used): low = one read of the diff, no full-file reads; high = 8
# angles; xhigh = 10 angles plus a sweep for gaps, about 3.5x the time of high.
#
# Risk = the attention CI leaves the owner (labels risk:low|mid|high|critical). From
# paths alone: low for docs, frontend, e2e and anything else (CI drives it unless the
# reviewer finds otherwise); mid for gateway/** but its tests (what
# next-gateway-version.sh releases to installed gateways) and for a crown-jewel path
# or content hit (worth a human read); critical for a `!` title (breaks installed
# gateways). high (CI can't check it) is only the reviewer's call. No device:* rule:
# those PRs stay draft until the owner's device test.
set -euo pipefail

# xhigh + mid: a changed file is under one of these paths (the crown jewels). Paths,
# not topics: CONTENT below catches the topics outside them. The broker's tests are
# here too: they are the tenant-isolation proof (CLAUDE.md).
XHIGH='
backend/src/StreamIq.Api/Data/
backend/src/StreamIq.Api/Auth/
backend/src/StreamIq.Api/Features/Broker/
backend/src/StreamIq.Api/Features/Gateways/
backend/tests/StreamIq.Api.Tests/Features/Broker/
gateway/internal/tunnel/
gateway/internal/pairing/
gateway/internal/identity/
gateway/internal/localpage/
gateway/internal/sessions/
gateway/install/install.sh
gateway/install/install.ps1
.github/workflows/
'
# xhigh + mid: an added line contains one of these (fixed strings), in any file:
# tenant-filter bypasses (as scripts/check-tenant-filter.sh) and the workflow settings that widen CI's power.
CONTENT='IgnoreQueryFilters
FromSql
ExecuteSql
SqlQuery
pull_request_target
secrets.
permissions:'
# low level: docs only (docs/ and *.md; the agent's own rules, CLAUDE.md and .claude/,
# are not docs). Everything else: high, however small.

if [ $# -gt 0 ]; then
  diff=$(gh pr diff "$1")
  title=$(gh pr view "$1" --json title --jq .title)
else
  git fetch -q origin
  diff=$(git diff origin/main...HEAD)
  title=$(gh pr view --json title --jq .title 2>/dev/null) ||
    echo "review-level: no PR for this branch, the \`!\` rule is not checked" >&2
fi
# Per file: `<file>\t<added>\t<removed>`; and every added line as `<file>\t<line>`.
# h = inside a hunk, so a removed `-- x` line isn't taken for a `--- a/file` header.
stats=$(awk '/^diff --git /{f=$4; sub(/^b\//,"",f); o[++n]=f; a[f]=0; r[f]=0; h=0; next}
  /^@@/{h=1} h&&/^\+/{a[f]++} h&&/^-/{r[f]++}
  END{for(i=1;i<=n;i++) print o[i] "\t" a[o[i]] "\t" r[o[i]]}' <<<"$diff")
added=$(awk '/^diff --git /{f=$4; sub(/^b\//,"",f); next} /^\+\+\+ /{next}
  /^\+/{print f "\t" substr($0,2)}' <<<"$diff")
[ -n "$stats" ] || { echo "review-level: empty diff" >&2; exit 1; }

level=low rank=0 why=docs evidence=
names=(low mid high critical)
raise() { if [ "$1" -gt "$rank" ]; then rank=$1 why=$2; fi; }
while IFS=$'\t' read -r f a r; do
  for p in $XHIGH; do
    case "$f" in "$p"*) level=xhigh; raise 1 crown-jewel
      evidence+="path: $f (+$a -$r)"$'\n' ;; esac
  done
  case "$f" in
    CLAUDE.md | .claude/*) ;;
    docs/* | *.md) continue ;;
  esac
  [ "$level" = xhigh ] || level=high
  [ "$rank" -gt 0 ] || why=other
  case "$f" in gateway/*_test.go) ;; gateway/*) raise 1 gateway-release ;; esac
done <<<"$stats"
while IFS= read -r pat; do
  hits=$(awk -v p="$pat" '{i = index($0, "\t")} index(substr($0, i + 1), p) {print substr($0, 1, i - 1)}' <<<"$added" | sort -u)
  [ -n "$hits" ] || continue
  level=xhigh; raise 1 content
  while IFS= read -r f; do evidence+="content: $f: $pat"$'\n'; done <<<"$hits"
done <<<"$CONTENT"

# `type!:` / `type(scope)!:` marks a breaking change (same pattern as next-gateway-version.sh).
[[ ${title:-} =~ ^[a-zA-Z]+(\([^\)]*\))?!: ]] && raise 3 breaking-title
echo "$level ${names[$rank]} $why"
printf '%s' "$evidence"
