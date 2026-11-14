#!/usr/bin/env bash
# Next gateway release version (#274), used by release-gateway.yml on a merge to main:
#   git ls-remote --tags --refs origin 'gateway-v*' | next-gateway-version.sh "<commit message>"
# Base = the highest stable gateway-v* tag on stdin (semver sort, prereleases skipped).
# A breaking subject (`type!:` / `type(scope)!:`) bumps the minor, anything else the patch.
# The major never changes here: the owner pushes gateway-vN.0.0 by hand and this follows it.
# `next-gateway-version.sh test` runs the self-check (check.sh + CI).
set -euo pipefail

next() { # $1 = tag refs/names, one per line; $2 = commit message
  local base ma mi pa
  base=$(sed -n 's#.*gateway-v##p' <<<"$1" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
  IFS=. read -r ma mi pa <<<"${base:-0.0.0}"
  if [[ ${2%%$'\n'*} =~ ^[a-z]+(\([^\)]*\))?!: ]]; then echo "$ma.$((mi + 1)).0"; else echo "$ma.$mi.$((pa + 1))"; fi
}

if [ "${1:-}" = test ]; then
  t() { got=$(next "$1" "$2"); [ "$got" = "$3" ] || { echo "FAIL: next('$1', '$2') = $got, want $3" >&2; exit 1; }; }
  tags=$'abc\trefs/tags/gateway-v0.0.9\nabc\trefs/tags/gateway-v0.0.10\nabc\trefs/tags/gateway-v0.0.2'
  t "$tags" "fix: x (#1)" 0.0.11                      # semver sort, not string sort
  t "$tags" "chore(ci): x" 0.0.11
  t "$tags" "feat!: x" 0.1.0
  t "$tags" "fix(gateway)!: x" 0.1.0
  t "$tags" $'fix: x\n\nfeat!: in the body only' 0.0.11  # only the subject counts
  t "$tags" "fix: x! y" 0.0.11
  t "$tags"$'\nabc\trefs/tags/gateway-v1.0.0' "fix: x" 1.0.1      # hand-pushed major is followed
  t "$tags"$'\nabc\trefs/tags/gateway-v2.0.0-rc.1' "fix: x" 0.0.11  # prereleases skipped
  t "" "fix: x" 0.0.1
  echo "next-gateway-version: ok"
  exit
fi

next "$(cat)" "$1"
