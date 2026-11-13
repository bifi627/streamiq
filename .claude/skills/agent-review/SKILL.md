---
name: agent-review
description: >-
  Use when an agent reviews a StreamIQ change and must sort findings into
  BLOCKER / SPEC / LOW: the builder's self-review of its branch before marking
  the PR ready, and the T3 task "agent label → review PR" before it posts the
  GitHub review. Picks the /code-review level, runs it without posting, triages
  strictly, returns the findings. Posts nothing. Not for a human-requested
  review (use /code-review directly).
---

The one home of the agent review's triage rules: the build's self-review and the
GitHub review task both use them, so their verdicts mean the same thing.

Target (`$ARGUMENTS`): a PR number, or nothing = the current branch vs `origin/main`.
Read-only: no commits, no pushes, no GitHub comments, no labels.

## 1. Spec

Read CLAUDE.md and each linked issue (`gh issue view <n>`; from a PR's
`closingIssuesReferences`, or the branch name `<type>/<n>-<slug>`). Its acceptance
criteria and out-of-scope list are the spec. A PR body that asks reviewers to check
something (e.g. a `## For the reviewer` list): answer each point.

## 2. Level

- `xhigh` if the diff touches a crown-jewel path: backend `Data/` (tenant filter,
  migrations), backend `Auth/`, the broker / gateway sockets (`Features/Broker`,
  `Features/Gateways`), `gateway/internal/{tunnel,pairing,identity,localpage}`, the
  gateway API allowlist/token handling, install scripts, or CI/release workflows.
- `medium` if the change is docs/CI-config only or under ~50 changed lines.
- otherwise `high`.

## 3. Review

Run the code-review skill WITHOUT posting: `/code-review <level> <target>` (no
`--comment`, no `--fix`). Collect its findings.

## 4. Triage

Each finding into exactly one bucket. Be strict; the default is LOW.

- **BLOCKER**: a concrete failure scenario you can state in one sentence that breaks
  a real user flow, loses/corrupts data, breaks tenant isolation, leaks a
  credential/PII, weakens auth/pinning, breaks the protocol between deployed gateways
  and the API (including deploy/release ordering), or makes a test pass by weakening
  it. Verify each against the code yourself; drop it if you can't confirm it.
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

## 5. Output

Return, in this order:

1. Level used.
2. Acceptance criteria: `all met` or `not met — <which>`.
3. Answers to what the PR body asked reviewers to check (if anything).
4. BLOCKER / SPEC findings, one per item: `[blocker]` or `[spec]` (+ `security`
   if so), `path:line` (or `path` for a file-level / cross-cutting one), the
   defect, and the one-sentence failure scenario.
5. LOW findings, one line each.

No praise, no summary of what the change does.
