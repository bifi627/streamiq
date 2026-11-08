#!/usr/bin/env bash
# Set an issue's Status on the StreamIQ project board (adds it if missing).
#   bash scripts/issue-status.sh 83 "In progress"
# Statuses: Backlog | Ready | In progress | In review | Done. Needs gh scope `project`.
set -euo pipefail
n=$1; status=$2
case $status in
  Backlog) opt=d170bba2 ;; Ready) opt=8eaaeffa ;; "In progress") opt=cb9ecacc ;;
  "In review") opt=a4f62931 ;; Done) opt=bee00628 ;;
  *) echo "unknown status: $status" >&2; exit 1 ;;
esac
item=$(gh project item-add 2 --owner bifi627 --url "https://github.com/bifi627/streamiq/issues/$n" --format json -q .id)
gh project item-edit --id "$item" --project-id PVT_kwHOBRnrLM4BqwMu \
  --field-id PVTSSF_lAHOBRnrLM4BqwMuzhpF3x4 --single-select-option-id "$opt" >/dev/null
echo "#$n -> $status"
