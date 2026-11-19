#!/usr/bin/env bash
# Fails when a Jellyfin endpoint path appears in frontend/src outside features/library/jellyfin.ts and tests (#557):
# every Jellyfin request the web client makes is listed there, next to the gateway allowlist it mirrors.
# ponytail: grep, not an AST rule; misses a path assembled from pieces, upgrade if one slips through.
set -euo pipefail
cd "$(dirname "$0")/.."

# Fail closed: a missing module must not read as "no paths".
[ -f frontend/src/features/library/jellyfin.ts ] || { echo "check-jellyfin-paths: jellyfin.ts missing" >&2; exit 2; }

# grep: exit 1 = no hits; anything else (2 = error) aborts.
rc=0
bad=$(grep -rnE --include='*.ts' --include='*.tsx' --exclude='*.test.ts' --exclude='*.test.tsx' --exclude=jellyfin.ts \
  '/(Items|Shows/|UserViews|UserItems/|Videos/|System/)' frontend/src) || rc=$?
[ "$rc" -le 1 ] || exit "$rc"

if [ -n "$bad" ]; then
  echo "Jellyfin endpoint path outside frontend/src/features/library/jellyfin.ts:" >&2
  echo "$bad" >&2
  echo "Add a path builder to jellyfin.ts (and the endpoint to the gateway allowlist, gateway/internal/tunnel/jellyfin.go) and call it." >&2
  exit 1
fi
echo "jellyfin paths: all in jellyfin.ts"
