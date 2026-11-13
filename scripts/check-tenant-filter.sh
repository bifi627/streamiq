#!/usr/bin/env bash
# Fails when backend/src bypasses the EF tenant query filter outside scripts/tenant-filter-allowlist.txt (#175).
# ponytail: grep, not a Roslyn analyzer; misses aliased/indirect calls, upgrade if one slips through.
set -euo pipefail
cd "$(dirname "$0")/.."

# Allowlist paths (comments + trailing blanks stripped), then hits whose file is not one of them (exact match).
bad=$(grep -rnE --include='*.cs' 'IgnoreQueryFilters|FromSql|ExecuteSql|SqlQuery' backend/src \
  | awk -F: 'NR == FNR { sub(/#.*/, ""); sub(/[ \t]+$/, ""); if ($0 != "") ok[$0]; next } !($1 in ok)' \
      scripts/tenant-filter-allowlist.txt - || true)

if [ -n "$bad" ]; then
  echo "Tenant-filter bypass outside the allowlist:" >&2
  echo "$bad" >&2
  echo "Avoid the bypass (let the tenant query filter apply), or add the file to scripts/tenant-filter-allowlist.txt" >&2
  echo "with a reason. Adding one is a review trigger: call it out in the PR." >&2
  exit 1
fi
echo "tenant filter: no bypasses outside the allowlist"
