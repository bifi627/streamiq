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
`origin/main`) prints a suggestion on its first line: the level (`xhigh`, `high` or
`low`), the risk label (section 5) and the rule that set it (e.g. `crown-jewel`), then
its evidence: the crown-jewel paths hit (with line counts) and the risky patterns in
added lines. The path lists and patterns live in that script and nowhere else.

The suggestion is where you start, not a rule. Read the diff, then pick the level
before you run the review (never change it afterwards to fit the result). Go lower
only when every hit is a comment or a single added line that changes no logic (e.g. a
`//nolint` comment, one added CI `run:` step calling a script; rewritten shell in a
workflow is logic and keeps `xhigh`), and a content hit only after you read its line
(an added `permissions:` or `secrets.` line may widen CI's power); go higher when the diff
touches tenant isolation, auth, the protocol or credentials outside the listed paths.
`xhigh` is the ceiling (`max` only when the owner asks). A level different from the
suggestion gets a few words of reason in your output (section 6). The level is only
the `/code-review` argument: your own reading of the spec and the triage below are
the same at every level.

## 3. Review

Run the code-review skill WITHOUT posting: `/code-review <level> <target>
--max-findings default`, where `<target>` is the PR number or the branch name, never
empty (empty = the working-tree diff, which is empty once everything is pushed). No
`--comment`, no `--fix`. Collect its findings.

**Follow-up review** (a build's fix round): instead of the above, when ALL of this
holds; if any doesn't, or you can't tell, run the full review above.

- The PR's build thread started you. The owner's `agent` label or request always gets
  the full review.
- The PR has an earlier agent review. The last one, as one JSON line
  `["<sha>","<body>"]` (its commit and its whole body):
  `gh api --paginate repos/bifi627/streamiq/pulls/N/reviews --jq '.[]|select(.body|contains("**Agent review**"))|[.commit_id,.body]|@json' | tail -1`
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
Sections 1, 2 (for the suggested risk), 4, 5 and 6 are the same, over the whole PR.

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
  New branching / ordering / timer logic in a `.tsx` without a `.ts` + `node --test`
  beside it (CLAUDE.md "Frontend decision logic lives in `.ts`"; render branching doesn't
  count).
- **LOW**: everything else (style, naming, simplification, defensive checks for
  impossible states, speculative edge cases, nits, "consider…"). Give each LOW one
  category from this fixed list, nothing else: `style naming dead-code simplify
  defensive test docs other`. The categories are a record for a later decision on rule
  files (#490), not a judgement: don't verify a LOW to categorize it.
- **Comments** (CLAUDE.md "Comments say what the code can't"), for comments the diff
  adds: history ("added in #N", "was X", an issue cited as a changelog entry) or
  commented-out code is a **BLOCKER** (`lint: no (needs reading; check-comments.sh catches only issue refs)` outside TS; in TS oxlint's `streamiq/no-low-value-comments` already fails on both, so a TS one can't reach review); a comment that restates
  the code, copies `docs/` or is a banner is **LOW** (`style`).

Cap: at most 5 BLOCKER + SPEC in total; if more qualify, keep the most severe and
say "+k more".

**Security-sensitive** (exploitable now): mark it `security`. It never goes on
GitHub; the caller gives the details to the owner only in its T3 thread.

## 5. Merge risk

Only when no BLOCKER/SPEC is left (the change would be `ready to merge`): how much
attention CI leaves the owner before merging. Not how dangerous the area is: a
crown-jewel change whose behavior a test drives needs a read, not a manual run. One
label:

| Label | When | The owner |
|---|---|---|
| `risk:low` | CI drives the changed behavior | merges |
| `risk:mid` | tests drive it, but it is crown-jewel, security or design code where a human read catches what tests don't (an isolation hole is a missing test), or what the gateway's auto-release ships | reads the diff |
| `risk:high` | CI can't check part of it: no e2e / Reqnroll / xUnit / Go test drives the changed behavior, it is visual / UX, or it depends on the real world (Firebase, TURN, a network) | does the named manual check |
| `risk:critical` | hard to undo: a migration that drops or rewrites data, a protocol / `gateway.env` / state dir / CLI change that reaches installed gateways | merges when they can watch the release |

The question that decides it: which test drives the changed behavior? Name it, or the
label is at least `risk:high`. Strictly:

- A helper's unit test doesn't drive the code that calls it: the caller's changed
  path needs its own test.
- A check that can only run after the merge (the prod smoke, a release) is not a test
  that drives it: `risk:high`, and name when to run it.
- A new check or gate (lint rule, `check.sh` step) is driven only if the PR shows it
  failing on a bad input (fixture, or a mutant in the PR body); else `risk:high`.
- A test-only diff: name the mutant the PR shows the new test catching, or say none.

Start at the script's suggested label and move it either
way with a reason. Going lower is also stated in the posted review (`agent-pr` puts
your merge-risk line in the body): the build's own reviewer has a reason to go easy,
so the owner must see it. A `device:*` label on the PR or its issue is a separate gate
(the PR stays a draft until the owner's device test): don't raise for it; a device-only
check without that label is `risk:high`.

## 6. Output

Return, in this order:

1. Level used (a level different from the script's: `<used> (suggested <level>):
   <reason>`), the script's suggestion as `suggested=<level>/<risk>`, and the counts: findings `/code-review` returned, then how many you
   sorted into BLOCKER, SPEC and LOW (all of them, not only the listed ones), the LOW
   count split by category, largest first (`low=7 lowcat=style:3,naming:2,simplify:2`).
2. Merge risk (when section 5 applies): `risk:<label> (suggested risk:<label>: <the
   script's rule>) — <reason, if different>; <the test that drives it, or for
   risk:high and up the manual check / what to watch>`.
3. Acceptance criteria: `all met` or `not met — <which>`.
4. Answers to what the PR body asked reviewers to check (if anything).
5. BLOCKER / SPEC findings, one per item: `[blocker]` or `[spec]` (+ `security`
   if so), `path:line` (or `path` for a file-level / cross-cutting one), the
   defect, and the one-sentence failure scenario. A BLOCKER also ends with
   `lint: <linter>: <rule or option>` when a rule of a linter we already have
   (oxlint with our plugin `frontend/lint/streamiq.js`, the .NET analyzers, golangci-lint, actionlint, shellcheck, the e2e
   `tsc`) would have caught it, else
   `lint: no (<why, a few words>)` (#556).
6. LOW findings, one line each, at most 5: only those a user would notice (wrong
   behavior, a visible glitch) AND that you confirmed by reading the code. Cleanups,
   style, naming, duplication, speculative edge cases and anything you didn't confirm
   are never listed, only counted: "+k more LOW, not listed". None qualifies → "no LOW
   worth listing", which is a normal result.
7. LOW record: every LOW candidate (the listed ones too), one line each:
   `category · path:line · finding` (`path` alone when there is no line). Unverified,
   for the record only: never a to-do for anyone, the caller included.

No praise, no summary of what the change does.
