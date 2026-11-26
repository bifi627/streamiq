#!/usr/bin/env bash
# CI drift for the weekly maintenance sweep (#981): median job durations on main this week
# vs the week before, and the tests that failed and then passed on a rerun. Reads gh only.
#   bash scripts/ci-drift.sh
set -euo pipefail
repo=bifi627/streamiq
day() { date -u -d "$1 days ago" +%F; }
now=$(date -u +%F)

# "<run> <job> <seconds>" for the required build jobs of the last 50 successful ci runs on
# main created in $1 (a gh `created` range). Shards and the e2e gate all count as `e2e`: the
# gate only waits for the shards (#973), so a run's longest `e2e` line is its slowest shard.
# ponytail: 50 runs per week (one API call each) are enough for a median
job_times() {
  local ids
  ids=$(gh api "repos/$repo/actions/workflows/ci.yml/runs?branch=main&status=success&created=$1&per_page=50" --jq '.workflow_runs[].id')
  for id in $ids; do
    gh api "repos/$repo/actions/runs/$id/jobs?per_page=100" --jq '.jobs[]
      | select(.conclusion == "success")
      | (.name | sub(" \\(.*"; "") | sub("^e2e-shard$"; "e2e")) as $n
      | select($n | IN("api","frontend","image","gateway-linux","gateway-windows","gateway-jellyfin","e2e"))
      | "\($n) \((.completed_at | fromdate) - (.started_at | fromdate))"' | sed "s/^/$id /"
  done
}

# job_times lines → "<job> <median seconds> <runs>", taking a job's longest line per run
medians() {
  awk '{k = $1 " " $2; if (!(k in m) || $3 > m[k]) m[k] = $3}
       END {for (k in m) {split(k, p, " "); print p[2], m[k]}}' |
    sort -k1,1 -k2,2n |
    awk '{v[$1] = v[$1] " " $2; n[$1]++}
         END {for (j in v) {split(substr(v[j], 2), a, " "); c = n[j]
              print j, (c % 2 ? a[(c + 1) / 2] : (a[c / 2] + a[c / 2 + 1]) / 2), c}}' | sort
}

echo "## CI times: median seconds per job, successful main runs ($(day 7)..$now vs $(day 14)..$(day 7))"
this=$(job_times "$(day 7)..$now" | medians)
prev=$(job_times "$(day 14)..$(day 7)" | medians)
join -a1 -e- -o 0,1.2,1.3,2.2,2.3 <(echo "$this") <(echo "$prev") |
  awk 'BEGIN {print "job this_week (runs) last_week (runs) change"}
       {ch = ($4 == "-" || $4 == 0) ? "n/a" : sprintf("%+.0f%%", ($2 - $4) * 100 / $4)
        flag = (ch != "n/a" && ($2 - $4) * 100 / $4 > 20) ? "  SLOWER >20%" : ""
        print $1, $2, "(" $3 ")", $4, "(" $5 ")", ch flag}' | column -t

echo
echo "## Flakes: failed, then passed on a rerun ($(day 7)..$now, main and PRs)"
runs=$(gh api --paginate "repos/$repo/actions/runs?created=$(day 7)..$now&per_page=100" \
  --jq '.workflow_runs[] | select(.run_attempt > 1 and .conclusion == "success") | "\(.id) \(.run_attempt) \(.head_branch)"')
found=$(
  while read -r id attempts branch; do
    [ -n "$id" ] || continue
    for ((a = 1; a < attempts; a++)); do
      log=$(gh run view -R "$repo" "$id" --attempt "$a" --log-failed 2>/dev/null || true)
      # the e2e gate on a draft PR fails by design: not a flake
      grep -q 'skipped = draft PR' <<<"$log" && continue
      tests=$( { grep '✘' <<<"$log" | grep -oE '[a-z0-9-]+\.spec\.ts:[0-9]+:[0-9]+ › .*' | sed -E 's/ *\([0-9.]+m?s\)$//; s/ +$//'
                 grep -oE -- '--- FAIL: [^ ]+' <<<"$log" | sed 's/--- FAIL: //'; } | sort -u)
      [ -n "$tests" ] || tests="(no test name; job: $(cut -f1 <<<"$log" | sort -u | paste -sd, -))"
      [ -n "$log" ] || tests="(log expired)"
      while read -r t; do echo "$t	$branch https://github.com/$repo/actions/runs/$id/attempts/$a"; done <<<"$tests"
    done
  done <<<"$runs"
)
if [ -z "$found" ]; then echo "none"; exit 0; fi
cut -f1 <<<"$found" | sort | uniq -c | sort -rn | while read -r n t; do
  [ "$n" -gt 1 ] && echo "SEEN ${n}x: $t" || echo "once: $t"
  grep -F "$t	" <<<"$found" | cut -f2 | sed 's/^/  /'
done
