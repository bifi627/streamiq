#!/usr/bin/env bash
# Golden-path check. Mirrors .github/workflows/ci.yml — if they disagree, that's a harness bug.
# Run this and READ the output before claiming any work done.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== docs drift: STREAMIQ_* env vars + gateway routes documented =="
bash scripts/check-docs-drift.sh

echo "== backend: tenant-filter bypasses + format + build + test =="
bash scripts/check-tenant-filter.sh
dotnet format backend/StreamIq.slnx --verify-no-changes
dotnet test backend/StreamIq.slnx --nologo

# Fresh worktrees have no node_modules (gitignored); install from the lockfile once.
for d in frontend e2e; do [ -d "$d/node_modules" ] || npm ci --prefix "$d"; done

echo "== frontend: format + lint + test + typecheck + build =="
npm run format:check --prefix frontend
(cd e2e && ../frontend/node_modules/.bin/prettier --check .)  # e2e has no own prettier; borrow frontend's
npm run lint --prefix frontend
npm test --prefix frontend
npm run build --prefix frontend

echo "== gateway: release version + fmt + vet + build + test =="
bash scripts/next-gateway-version.sh --test
if command -v go >/dev/null 2>&1; then
  (cd gateway && test -z "$(gofmt -l .)" || { echo "gofmt needed:"; gofmt -l .; exit 1; }
   # -race needs cgo; Go reports CGO_ENABLED=0 with no C compiler (e.g. Windows without gcc)
   race=; [ "$(go env CGO_ENABLED)" = 1 ] && race=-race
   # one command per line: under set -e a failure inside an && chain only counts in its last command
   go vet ./...
   go build ./...
   go test $race ./...
   # #453 (CI job gateway-jellyfin): the real pinned Jellyfin in Docker, ~1 min. The pin bump
   # needs the last release's compose file; without gh (or offline) that half is skipped.
   old=$(mktemp -d); command -v cygpath >/dev/null && old=$(cygpath -m "$old")  # Go on Windows can't read /tmp
   if gh release download --pattern jellyfin-compose.yml --dir "$old" >/dev/null 2>&1; then
     export STREAMIQ_TEST_OLD_JELLYFIN_COMPOSE="$old/jellyfin-compose.yml"
   else
     echo "!! gh release download failed: the Jellyfin pin-bump test is SKIPPED here, CI runs it" >&2
   fi
   go vet -tags docker ./internal/jellyfin/
   go test -tags docker -run TestRealJellyfin -timeout 15m ./internal/jellyfin/)
else
  # ponytail: the dev machines have Go; this is for a fresh checkout without it. CI still runs it
  echo "!! SKIPPED: go not installed locally — gateway is UNVERIFIED here, CI will run it" >&2
fi

# #469: a build narrows this to the areas it touched (E2E_GREP=@player) or skips it for a change
# without e2e impact (SKIP_E2E=1); a full local run only when the owner asks. CI sets neither.
if [ -n "${SKIP_E2E:-}" ]; then
  echo "!! SKIPPED: e2e (SKIP_E2E set) — the browser specs are UNVERIFIED here, CI will run them" >&2
elif [ -n "${E2E_GREP:-}" ]; then
  echo "== e2e: only --grep \"$E2E_GREP\" (E2E_GREP set; CI runs all specs) =="
  npm test --prefix e2e -- --grep "$E2E_GREP"
else
  echo "== e2e: all specs, in parallel (Docker + Chrome; no Chrome? npx playwright install chrome in e2e/) =="
  npm test --prefix e2e
fi

echo "== compose config =="
docker compose config --quiet
docker compose --profile relay config --quiet

echo "== ALL CHECKS PASSED =="
