---
name: replay
description: Use when mining past Claude Code session transcripts to surface and reconcile memories the agent never wrote down — recurring preferences, corrections, naming/tooling/formatting conventions, or decisions that span sessions. Triggered by "replay my sessions", "what did I forget to remember", "mine the transcripts", or /replay. Complements dreamer (which curates already-written memory; replay reads the JSONL transcripts). Not for writing one memory by hand or tidying the existing store — use dreamer for that.
---

# replay — mine session transcripts into memory

## Overview

Past sessions are full of durable signal — preferences you stated, corrections you made, conventions you live by — that nobody ever ran `Write` on. `replay` reads the JSONL transcripts, surfaces that signal as candidate memories, reconciles it against the store, and applies it **non-destructively, with you adjudicating anything uncertain**.

**Core principle: every memory must trace to a quoted turn, and nothing risky is written without your say-so.** A capable model already extracts *okay*; the value here is process — grounding, staging, asking, and handling scale. Where `dreamer` curates what's written against the repo, `replay` mines what was *said* against the transcripts.

This is a **technique** skill — adapt the judgment, but the safety rules (grounded evidence, stage-then-apply, ask-on-uncertainty) are rigid.

## When to use

- The user asks to mine/replay past sessions, surface forgotten preferences, or invokes `/replay`.
- Periodically, to catch conventions that recurred across sessions but were never saved.

Not for: writing a single memory by hand (just write it), or curating/normalizing the already-written store (that's `dreamer`).

## The five phases

Run in order. Phases 1, 3, 4, 5 are **in-session** (you, the orchestrator). Phase 2 fans out to subagents.

### 1. SELECT (in-session)

- **Locate.** The memory store is `~/.claude/projects/<project-slug>/memory/`, where `<project-slug>` is the main checkout's path with every non-alphanumeric character turned into `-` (`C:\Repositories\streamiq` → `C--Repositories-streamiq`). Worktree sessions share that store, but each worktree writes its transcripts to its own project dir, named the same way from the worktree's path. The transcripts are the `*.jsonl` files in the main `<project-slug>` dir **plus** every worktree dir: the dirs whose name starts with the slug of the worktrees' parent folder (`git worktree list` shows it; T3 worktrees live in `~/.t3/worktrees/<repo>/`, slug prefix `C--Users-<user>--t3-worktrees-<repo>-`). Match by that prefix, not by the current `git worktree list`: pruned worktrees are gone from the list but their transcripts stay.
- **Watermark.** Read `memory/.replay-state.json` (`{ "processed": [<sessionId>…], "last_run": <iso> }`). Absent → first run, everything pending.
- **Pending** = transcripts whose `sessionId` (the filename) isn't in `processed`, **excluding the currently-active session** — in practice the most-recently-modified `.jsonl`, which is the one *this* run is writing. Never mine it.
- **Nothing pending?** If `pending` is empty, report "no new sessions since the last replay" and **stop** — no extraction, no spend. (This is the steady-state outcome once you've replayed recently.)
- **Batch guard.** Count pending. If **> 10** (default; the threshold is the "more than expected" line), STOP and ask before spending anything:
  `Found N pending sessions (~K tokens reduced). → [a] mine all (in waves) · [b] most-recent M · [c] date cutoff · [d] cancel`.
  ≤ 10 → proceed silently. First run (all pending) is just this guard firing.

### 2. EXTRACT (parallel subagent map — Sonnet, flat)

Dispatch **one subagent per pending transcript**, `model: sonnet`, in waves. Each subagent:
- Is given the transcript path and **MUST run `reduce_transcript.py <path>` itself** (in this skill's directory) and work only from the reduced output. **Never read a raw transcript into context** — yours or the subagent's; the reducer exists because raw transcripts blow the context window.
- Is given the current `MEMORY.md` index (the ~one-liners) so it skips re-proposing the obviously-known.
- Returns **structured candidates only** (the schema below), not prose.
- **Must NOT spawn its own subagents** (flat orchestrator → workers). Say so in the dispatch.

### 3. RECONCILE (in-session, this model)

Collect all candidates. Read the relevant memory files (the store is small — match against the whole thing, no embeddings). Assign one verdict per candidate:

- **ADD** — no existing match → net-new memory.
- **UPDATE** — matches an existing memory but changes/refines it.
- **DELETE** — transcript evidence shows an existing memory is now wrong (rare).
- **NOOP** — already captured accurately → drop.

**Aggregate across transcripts here:** the same fact from 3 sessions becomes one op with combined `recurrence`, all evidence quotes, and the timestamp span. **Recurrence across sessions is the strongest durability signal** — "said once in three sessions" beats "three times in one."

### 4. TRIAGE (in-session)

Tag every op (see the table below): **auto** (stage, show in summary), **ask** (adjudicate with the user), or **drop**. Collect ask items — do not fire them mid-reconcile.

### 5. APPLY (in-session, guided, git-agnostic)

1. **Stage.** Build `memory.dream/` = a copy of `memory/` with the **auto** ops applied. (Ephemeral; this is the non-destructive output.)
2. **Review.** Show the auto ops as a summary diff (`N adds · M updates · K deletes`, one line each). Present the **ask** items in batches of ≤4 — each with its candidate, verbatim evidence, and the existing memory it touches — and let the user keep / edit / reject.
3. **Apply** (only after approval), in order:
   - **Back up:** `cp -r memory memory.backup-<timestamp>` (the git-agnostic revert path — do this even if the store is under git).
   - Apply auto + confirmed-ask ops to live `memory/` (write/edit/delete files).
   - Stamp `metadata.originSessionId` on every added/updated memory (its strongest source session).
   - Update `MEMORY.md` for adds/deletes — **index and files move together**.
   - Advance the watermark: write the now-processed `sessionId`s + timestamp to `.replay-state.json`.
   - Delete `memory.dream/`.
4. **Hand off.** Recommend a `dreamer` run on the freshly-applied store (normalize ids, verify links, reconcile vs repo). **Issue no `git` commands** — version control of the memory store, if any, is the user's own workflow.
5. **Report.** End with one line: `N applied (A adds · U updates · D deletes) · Y asked · Z dropped as noise`. If any asked items were preferences first seen this batch, note them — a nudge that those should be saved at write-time, not only caught later by replay.

## Candidate schema

```
{ proposed_type: feedback | user | project | reference,
  signal: explicit | implicit,     # explicit = stated/corrected/approved; implicit = consistent behavioral pattern
  proposed_name: <kebab slug>,     description: <one-line>,
  body: <the fact, in the store's voice>,
  evidence: <verbatim quote (explicit) OR cited recurring instances + count (implicit)>,
  session_id, timestamp,           # provenance
  recurrence: <# distinct turns within this transcript>,
  extractor_confidence: low | med | high }
```

## Extraction criteria

| Type | Priority | Signal |
|------|----------|--------|
| **feedback** | primary | **Technical preferences** — naming conventions, tool/library/command choices, formatting & style, workflow/verification habits — plus corrections ("no, use X not Y"), stated rules ("always/never/from now on"), confirmed approaches ("yes, do it that way"). The densest vein. |
| **user** | high | Who they are — role, expertise, durable preferences. |
| **project** | conservative | Only constraints/decisions **not derivable from code or git**. Most project facts are repo-derivable → leave them to `dreamer`. |
| **reference** | opportunistic | A URL/dashboard/ticket repeatedly returned to. Rare. |

**Hard noise filter (drop):** one-off/ephemeral facts ("port busy today"), task-specific detail, anything repo/git-derivable, anything the index already covers (unless the transcript *contradicts* it).

**Grounding is mandatory.** Every candidate carries a verbatim quote + session_id + timestamp, or it is dropped. **Explicit** preferences (stated/corrected/approved) ground on a statement quote and may auto-stage. **Implicit** preferences — a consistent *choice among real alternatives* made without objection (block braces, Bash over PowerShell, kebab-case), not arbitrary tool use — ground on a behavioral pattern (cited instances + count), surface **only when the pattern is consistent: ≥2 cited instances** (within a session, or — more convincingly — across sessions) with zero contradicting corrections, and **always route to `ask`, never auto**. A single incidental occurrence is dropped. (Extraction is stochastic — one run may surface an implicit pattern that another misses; that's fine, the user is the gate and nothing implicit is ever auto-applied.)

## Triage

| Op | Auto-stage (summary) | Ask |
|----|------|-----|
| **NOOP** | — (dropped) | — |
| **ADD** | high: recurred ≥2 sessions, strong quote, durable, `feedback`/`user` | low/med: seen once, borderline durable-vs-one-off, or a `project` candidate maybe repo-derivable |
| **UPDATE** | only an obvious, unambiguous refinement | **default** — alters curated knowledge |
| **DELETE** | never | **always** — most destructive op |
| **any op, implicit signal** | never | **always** — surfaced only if consistent (≥2 cited instances, no contradiction); a lone incidental occurrence is dropped |

**The six ask-triggers:** (1) contradiction with no clear current value, (2) durable-vs-one-off uncertainty, (3) any DELETE / destructive UPDATE, (4) a merge that would collapse a real distinction, (5) a `project` candidate possibly already in the repo, (6) an implicit preference.

**Guardrail:** ask *only* when the answer changes what gets written **and** can't be settled from the quoted evidence. If the quote resolves it, auto-stage — don't perform a question. (Don't drown the value under 30 prompts.)

## Models

- **EXTRACT subagents: Sonnet.** Highest volume; bounded, schema'd judgment. Don't go below Sonnet — signal-vs-noise discrimination is the whole point. (Bump to Opus for a deliberate "thorough" run.)
- **RECONCILE / TRIAGE / APPLY: this session's model** (the orchestrator). Lowest volume, highest stakes.
- **All subagents are flat** — no nested spawning.

## Verification — before you claim done

- Every applied (added/updated) memory carries `metadata.originSessionId`.
- `MEMORY.md` line count == memory `*.md` file count (minus MEMORY.md); no dangling links.
- A `memory.backup-<timestamp>/` exists from this run.
- `.replay-state.json` lists the sessions just processed.
- `memory.dream/` is gone.
- You (the orchestrator) never read a raw transcript — only reduced output (via subagents) and structured candidates.

## Common mistakes

- **Reading raw transcripts.** Always go through `reduce_transcript.py`; the orchestrator should never hold transcript text at all.
- **Auto-applying a contradiction or a delete.** Those are the exact cases to ask. Silent overwrite of curated memory is the headline failure replay exists to prevent.
- **Writing to live `memory/` before review / without a backup.** Stage to `memory.dream/`, back up, then apply.
- **Inventing a memory with no quotable turn.** No evidence → drop. (The antidote to compounding hallucination.)
- **Treating "agent did X and wasn't corrected" as auto.** Implicit signals always ask, and only when strong.
- **Forgetting `originSessionId`, or updating files but not `MEMORY.md`.** Provenance and index move with every change.
- **Running `git` against the memory store.** replay is git-agnostic; hand off to `dreamer` and stop.
