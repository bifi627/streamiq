#!/usr/bin/env bash
# Issue hygiene: list every open issue that breaks a labelling / spec / board rule
# (CLAUDE.md "Tracking"). One line per finding; exit 1 if any, 2 on error. Fixes nothing.
#   bash scripts/issue-lint.sh
# One GraphQL call (issues + their board status). Needs gh scope `project`.
set -euo pipefail
# ponytail: one page of 100 open issues; fails loudly past that, paginate when it does
out=$(gh api graphql -f query='{repository(owner:"bifi627",name:"streamiq"){issues(states:OPEN,first:100){
  pageInfo{hasNextPage}
  nodes{number body labels(first:30){nodes{name}} subIssues{totalCount}
    projectItems(first:10){nodes{project{number} status:fieldValueByName(name:"Status"){
      ... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}}' --jq '
  .data.repository.issues as $i
  | if $i.pageInfo.hasNextPage then "more than 100 open issues: paginate issue-lint.sh" | halt_error(2) else . end
  | $i.nodes[] | . as $n | [.labels.nodes[].name] as $l
  | ([.projectItems.nodes[] | select(.project.number == 2) | .status.name // "none"] | first) as $s
  | ($l | index("needs-spec")) as $ns
  | ( (if ($l | map(select(. == "bug" or . == "tech-debt" or . == "idea")) | length) != 1 then "needs exactly one type label (bug / tech-debt / idea)" else empty end),
      (if ($l | map(select(test("^p[1-3]$"))) | length) != 1 then "needs exactly one priority (p1-p3)" else empty end),
      (if ($l | map(select(startswith("area:"))) | length) == 0 then "no area:* label" else empty end),
      (if ($n.subIssues.totalCount == 0) and ($l | map(select(startswith("size:"))) | length) == 0 then "no size:* label" else empty end),
      (if ($ns | not) and ($n.body | test("(?im)^(#+[[:blank:]]*|[*][*])acceptance criteria") | not) then "no acceptance criteria and no needs-spec" else empty end),
      (if $s == null then "not on the board"
       elif $s == "none" then "on the board without a status"
       elif $ns and $s != "Backlog" then "needs-spec but board says \($s) (should be Backlog)"
       elif ($ns | not) and $s == "Backlog" then "approved spec but board says Backlog (should be Ready)"
       else empty end)
    ) | "#\($n.number) \(.)"') || exit 2  # gh/auth error or >100 issues: not a finding
[ -z "$out" ] && { echo "issue-lint: clean"; exit 0; }
echo "$out"
exit 1
