#!/usr/bin/env bash
# Fails when backend/src bypasses the EF tenant query filter outside scripts/tenant-filter-allowlist.txt (#175).
# ponytail: grep, not a Roslyn analyzer; misses aliased/indirect calls, upgrade if one slips through.
set -euo pipefail
cd "$(dirname "$0")/.."

allowlist=scripts/tenant-filter-allowlist.txt
# Fail closed: a missing input must not read as "no bypasses".
[ -f "$allowlist" ] && [ -d backend/src ] || { echo "check-tenant-filter: $allowlist or backend/src missing" >&2; exit 2; }

# grep: exit 1 = no hits; anything else (2 = error) aborts.
rc=0; hits=$(grep -rnE --include='*.cs' 'IgnoreQueryFilters|FromSql|ExecuteSql|SqlQuery' backend/src) || rc=$?
[ "$rc" -le 1 ] || exit "$rc"

# Allowlist paths (comments + trailing blanks stripped), then hits whose file is not one of them (exact match).
# FILENAME, not NR == FNR: an empty allowlist must not turn the hits into keys.
bad=$(printf '%s\n' "$hits" | awk -F: -v list="$allowlist" '
  FILENAME == list { sub(/#.*/, ""); sub(/[ \t]+$/, ""); if ($0 != "") ok[$0]; next }
  $0 != "" && !($1 in ok)' "$allowlist" -)

if [ -n "$bad" ]; then
  echo "Tenant-filter bypass outside the allowlist:" >&2
  echo "$bad" >&2
  echo "Avoid the bypass (let the tenant query filter apply), or add the file to scripts/tenant-filter-allowlist.txt" >&2
  echo "with a reason. Adding one is a review trigger: call it out in the PR." >&2
  exit 1
fi
echo "tenant filter: no bypasses outside the allowlist"
