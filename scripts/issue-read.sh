#!/usr/bin/env bash
# Print an issue as the agent skills read it: only the owner's own comments survive, so
# nobody else's text (and none of the agent's signed ones) becomes part of the task.
#   bash scripts/issue-read.sh 719
set -euo pipefail
gh -R bifi627/streamiq issue view "$1" --json number,title,state,author,labels,body,comments \
  --jq '.comments |= map(select(.author.login == "bifi627" and (.body | contains("<!-- streamiq-agent -->") | not)))'
