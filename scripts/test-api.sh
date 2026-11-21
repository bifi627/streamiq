#!/usr/bin/env bash
# The Go API's tests (check.sh + CI): one Postgres and one Firebase Auth emulator for the
# whole run, removed on exit; each test package makes its own database on that Postgres
# (api/internal/apitest). Extra args go to go test (e.g. -race).
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1 # Git Bash: keep /var/lib/postgresql and /app container paths

fb=dev/firebase
tag=streamiq-firebase-emulator:$(cat "$fb/Dockerfile" "$fb/firebase.json" | sha256sum | cut -c1-12) # apitest's and e2e's tag
docker image inspect "$tag" >/dev/null 2>&1 || docker build -q -t "$tag" "$fb" >/dev/null
pg=$(docker run -d --rm -e POSTGRES_PASSWORD=dev --tmpfs /var/lib/postgresql -p 127.0.0.1::5432 \
  "$(sed -n 's/^ *image: \(postgres:.*\)$/\1/p' docker-compose.yml)")
trap 'docker rm -f "$pg" ${em:+"$em"} >/dev/null' EXIT
em=$(docker run -d --rm -p 127.0.0.1::9099 -w /app "$tag" firebase emulators:start --only auth --project demo-streamiq)

# The tests wait for both to accept connections.
STREAMIQ_TEST_POSTGRES="postgres://postgres:dev@$(docker port "$pg" 5432/tcp | head -1)/postgres" \
STREAMIQ_TEST_FIREBASE="$(docker port "$em" 9099/tcp | head -1)" \
  go test "$@" ./api/...
