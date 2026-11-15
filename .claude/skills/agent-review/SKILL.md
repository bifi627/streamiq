---
name: agent-review
description: >-
  Use when an agent reviews a StreamIQ change and must sort findings into
  BLOCKER / SPEC / LOW: called by `agent-pr` before it posts the GitHub review
  (a build's review of its own PR and the `agent` label on a PR both go through
  it). Picks the /code-review level, runs it without posting, triages
  strictly, returns the findings. Posts nothing. Not for a human-requested
  review (use /code-review directly).
---

The one home of the agent review's triage rules: every posted agent review
(`agent-pr`) uses them, so a verdict means the same thing whoever started it.

Target (`$ARGUMENTS`): a PR number, or nothing = the current branch
(`git branch --show-current`) vs `origin/main`. The diff under review is `gh pr diff N`
for a PR, else `git fetch -q origin && git diff origin/main...HEAD`; it must not be empty
(empty = say so and stop: nothing was reviewed).
Read-only: no commits, no pushes, no GitHub comments, no labels.

## 1. Spec

Read CLAUDE.md and each linked issue (`gh issue view <n>`; from a PR's
`closingIssuesReferences`, or the branch name `<type>/<n>-<slug>`). Its acceptance
criteria and out-of-scope list are the spec; no linked issue (e.g. Dependabot) → the
PR body is the spec. A PR body that asks reviewers to check
something (e.g. a `## For the reviewer` list): answer each point.

## 2. Level

`bash scripts/review-level.sh <PR number>` (no number = the current branch vs
`origin/main`) prints three words: the level (`xhigh`, `high` or `low`), the merge-risk
floor (0–10, section 5) and the rule that set it (e.g. `crown-jewel`). Use the level it prints; don't judge it yourself. Both rules
(the crown-jewel paths, what counts as docs only, the floors) live in that script and
nowhere else. The level is only the `/code-review` argument: your
own reading of the spec and the triage below are the same at every level.

## 3. Review

Run the code-review skill WITHOUT posting: `/code-review <level> <target>
--max-findings default`, where `<target>` is the PR number or the branch name, never
empty (empty = the working-tree diff, which is empty once everything is pushed). No
`--comment`, no `--fix`. Collect its findings.

**Follow-up review** (a build's fix round): instead of the above, when ALL of this
holds; if any doesn't, or you can't tell, run the full review above.

- The PR's build thread started you. The owner's `agent` label or request always gets
  the full review.
- The PR has an earlier agent review. The last one:
  `gh api --paginate repos/bifi627/streamiq/pulls/N/reviews --jq '.[]|select(.body|contains("**Agent review**"))|.commit_id' | tail -1`
  prints its commit `<sha>`; read its body the same way (`.body`).
- That body says nothing of a finding "sent to owner privately" or of "more, see the
  T3 thread": such a finding has no GitHub thread, so only a full review finds it again.
- Only fix commits came after it. `<head>` = the PR's `headRefOid` from `gh pr view`
  (never `FETCH_HEAD`: any other fetch in the checkout rewrites it). After
  `git fetch -q origin pull/N/head`: `git merge-base --is-ancestor <sha> <head>` holds
  (not after a rebase) and `git rev-list --merges <sha>..<head>` prints nothing (not
  after `main` was merged in).

Then do NOT run `/code-review`: it would review the whole PR again and return its
minimum of new candidates every round. Read `git diff <sha>..<head>` yourself, with
the files around it: did these commits fix what they were for, and did they break
anything? Your findings are what these commits introduced or left unfixed; the level
you report is `delta`, the candidates the number you found (0 is a normal result).
Sections 1, 2 (for the merge-risk floor), 4, 5 and 6 are the same, over the whole PR.

## 4. Triage

Each finding into exactly one bucket. Be strict; the default is LOW.

What `/code-review` returns is unverified candidates: it is told to prefer recall
over precision and to reach a minimum number of findings, most of its angles hunt
cleanups, and it checks nothing. So expect LOW items and wrong ones on a clean change.
You are the only verification: read the code for every BLOCKER and SPEC candidate and
confirm it yourself before you report it. One you can't confirm is dropped (a BLOCKER)
or LOW (a SPEC); a posted finding blocks the merge and costs a fix round.

- **BLOCKER**: a concrete failure scenario you can state in one sentence that breaks
  a real user flow, loses/corrupts data, breaks tenant isolation, leaks a
  credential/PII, weakens auth/pinning, breaks the protocol between deployed gateways
  and the API (including deploy/release ordering), or makes a test pass by weakening
  it.
- **SPEC**: an acceptance criterion not met; out-of-scope work / a drive-by fix in the
  diff; docs the change invalidated left stale (`docs/tools.md` for tools/credentials,
  `docs/protocol.md` for protocol); a new dependency with no justification in the PR
  body; a new or changed test that doesn't actually prove the acceptance criterion it
  is there for, or that can hang instead of fail (no timeout on a wait).
- **LOW**: everything else (style, naming, simplification, defensive checks for
  impossible states, speculative edge cases, nits, "consider…").

Cap: at most 5 BLOCKER + SPEC in total; if more qualify, keep the most severe and
say "+k more".

**Security-sensitive** (exploitable now): mark it `security`. It never goes on
GitHub; the caller gives the details to the owner only in its T3 thread.

## 5. Merge risk

Only when no BLOCKER/SPEC is left (the change would be `ready to merge`): how much the
owner should test before merging, 0–10. Start at the script's floor; never go below it.
Go higher, with the reason, for each of these the diff shows:

- **Blast radius:** tenant isolation, auth, pairing, the protocol or every page, rather
  than one screen.
- **Hard to undo:** a migration that drops or rewrites data, a state dir / `gateway.env` /
  CLI change, anything the gateway's auto-release ships to installed gateways (a frontend
  or API redeploy is easy to undo).
- **Untested behavior:** no e2e / Reqnroll / xUnit / Go test drives the changed behavior.
- **Unflagged device check:** it can only really be checked on a TV, a phone, cellular
  or relay, but neither the PR nor its issue has a `device:*` label. (With the label,
  the PR stays a draft until the owner's device test: that gate covers it, no raise.)

Bands: 0–1 = merge without a second look · 2–4 = skim the diff · 5–7 = drive the named
flows yourself (`dev.ps1` or `/preview`) · 8–10 = test deeply on the named flows and
devices, merge when you can watch the gateway release. From 5 up, name the concrete
flows to test (e.g. "accept an invite into a second household, then open its gateway").

## 6. Output

Return, in this order:

1. Level used, and the counts: findings `/code-review` returned, then how many you
   sorted into BLOCKER, SPEC and LOW (all of them, not only the listed ones).
2. Merge risk (when section 5 applies): `<n>/10 (floor <f>: <the script's rule>) — <reason
   for going higher, if any>; test: <flows>` (no `test:` part below 5).
3. Acceptance criteria: `all met` or `not met — <which>`.
4. Answers to what the PR body asked reviewers to check (if anything).
5. BLOCKER / SPEC findings, one per item: `[blocker]` or `[spec]` (+ `security`
   if so), `path:line` (or `path` for a file-level / cross-cutting one), the
   defect, and the one-sentence failure scenario.
6. LOW findings, one line each, at most 5: only those a user would notice (wrong
   behavior, a visible glitch) AND that you confirmed by reading the code. Cleanups,
   style, naming, duplication, speculative edge cases and anything you didn't confirm
   are never listed, only counted: "+k more LOW, not listed". None qualifies → "no LOW
   worth listing", which is a normal result.

No praise, no summary of what the change does.
