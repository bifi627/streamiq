#!/usr/bin/env bash
# Golden-path check. Mirrors .github/workflows/ci.yml — if they disagree, that's a harness bug.
# Run this and READ the output before claiming any work done.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== backend: format + build + test =="
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

echo "== gateway: fmt + vet + build + test =="
if command -v go >/dev/null 2>&1; then
  (cd gateway && test -z "$(gofmt -l .)" || { echo "gofmt needed:"; gofmt -l .; exit 1; }
   go vet ./... && go build ./... && go test ./...)
else
  # ponytail: Go absent on the primary Windows machine; CI still runs it
  echo "!! SKIPPED: go not installed locally — gateway is UNVERIFIED here, CI will run it" >&2
fi

echo "== e2e: golden path (Docker + Chrome; no Chrome? npx playwright install chrome in e2e/) =="
npm test --prefix e2e

echo "== compose config =="
docker compose config --quiet
docker compose --profile relay config --quiet

echo "== ALL CHECKS PASSED =="
