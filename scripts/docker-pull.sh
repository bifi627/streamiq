#!/usr/bin/env bash
# CI: pull pinned images before the tests start them, retrying a failed pull: `docker run`,
# compose and testcontainers pull a missing image once, so a Docker Hub hiccup fails the job.
#   docker-pull.sh [-f compose.yml] image...
# image = name:tag as is, or a name without tag (jellyfin/jellyfin) whose tag is the pin in the
# compose file (path from the repo root, default docker-compose.yml). Ends with "pulled all".
set -euo pipefail
cd "$(dirname "$0")/.."
file=docker-compose.yml
if [ "${1:-}" = -f ]; then file=$2; shift 2; fi
for name in "$@"; do
  case $name in
    *:*) image=$name ;;
    *) image=$(sed -n "s|^ *image: \($name:[^ ]*\)\$|\1|p" "$file" | head -1) ;;
  esac
  [ -n "$image" ] || { echo "no $name image pin in $file" >&2; exit 1; }
  for try in 1 2 3; do
    docker pull -q "$image" && break
    [ "$try" = 3 ] && { echo "pull $image failed 3 times" >&2; exit 1; }
    echo "pull $image failed, retry in $((try * 15)) s" >&2
    sleep $((try * 15))
  done
done
echo "pulled all"
