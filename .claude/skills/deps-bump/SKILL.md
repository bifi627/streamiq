---
name: deps-bump
description: >-
  Use when bumping dependencies in StreamIQ — npm (frontend/e2e:
  React / Vite / TypeScript), Go modules (gateway + API), pinned Docker images
  (compose: Jellyfin/Postgres/coturn), GitHub Actions, or devcontainer
  features. Triggered by a Dependabot alert (Security tab), an explicit "update X" request, or a
  periodic outdated sweep. Do NOT use for adding a brand-new dependency or for
  code refactors that happen to touch package.json.
---

# StreamIQ dependency bumps

## Core principle

**Group into smart waves to minimize verify runs; commit per wave on a
`chore/deps-*` branch.** One full verify cycle is the budget unit — don't
burn it per package.

## Derive the work, then wave it

This skill stores no pending-bump state — derive the candidate set at runtime:

```bash
npm outdated --prefix frontend            # and any other package dirs (e2e/)
go list -m -u all                          # Go modules (one go.mod at the root: api/ + gateway/)
gh api repos/bifi627/streamiq/dependabot/alerts?state=open --jq '.[] | "\(.number) \(.dependency.manifest_path) \(.security_vulnerability.package.name) → \(.security_vulnerability.first_patched_version.identifier)"'  # open alerts: bump each to at least its patched version, or dismiss it in the Security tab with a reason (docs/tools.md)
# plus: image pins in docker-compose.yml, .devcontainer/devcontainer.json
#       features, and action versions in .github/workflows/*.yml
```

Then:

1. **Patches + safe minors, all stacks together** — one wave, one verify.
2. **Majors, one at a time**, ordered least → most blast radius: CI/build
   tooling < test infra < build chain (Vite/TS/Go toolchain) < frameworks
   (React/Pion). Pause and confirm before starting each major (AskUserQuestion: start it / skip /
   stop).
   Workflow pattern: user says "continue with X" → do X → summarize → wait.

**Lockstep groups** — bump together, never split:

| Group | Members |
|---|---|
| Vite | `vite` + `@vitejs/plugin-react` (check peers first: `npm view <pkg> peerDependencies`) |
| TypeScript | `typescript` + any ts-coupled lint tooling (its peer range caps the TS version) |
| React | `react` + `react-dom` + `@types/react` + `@types/react-dom` |
| Pion | `pion/webrtc` and its transitive pion siblings — take what `go get -u` resolves together |

**Jellyfin image pin is NOT a routine bump.** The gateway drives Jellyfin's
API; a Jellyfin bump needs the integration tests against the new pin and a
manual play/seek check — treat it as a major, always its own wave. CI's
`gateway-jellyfin` restores a backup made by the last release's pin into the new
one (#453): if it fails, Jellyfin refuses old backups, and the PR says so.

## Per-wave verify (default, don't skip)

```bash
SKIP_E2E=1 bash scripts/check.sh          # default: format, lint, tests, build, compose config; CI runs the full e2e suite on the PR
E2E_GREP=@golden bash scripts/check.sh    # instead, when the bump changes what the e2e specs exercise (list below)
```

Narrow e2e (`E2E_GREP=@golden`) for: frontend runtime packages (React, Vite),
Playwright / e2e deps, the gateway's WebRTC (Pion), the Jellyfin / Postgres image
pins; one such package in a mixed wave puts the whole wave on `@golden`. Everything else: `SKIP_E2E=1` (`check.sh` prints `!! SKIPPED: e2e …`).
Never a full local e2e run (a Jellyfin per worker) unless the owner asks.

Integration tests are NOT "expensive" — include by default. Docker daemon
down → prompt the user to start Desktop, don't skip.

## npm specifics

- **Use caret-minor (`^x.y.z`); never `~`, `*`, or `x.*`.** Exact pinning
  makes `npm audit fix` flag every advisory as breaking (no range overlap
  with patched versions ⇒ requires `--force`). Reproducibility comes from
  the committed `package-lock.json` + `npm ci` in CI, not from declared
  ranges.
- **`.npmrc` hardening (present in every package dir):** `ignore-scripts=true`
  (skips lifecycle scripts — supply-chain defense) and `min-release-age=7`
  (refuses versions <7 days old). **Never override `min-release-age`** — no
  `--min-release-age=0`, not even for a CVE patch; take the newest version
  that already clears the 7-day quarantine instead.
- **Two workflows depending on what's moving:**
  - **Range change** (bump the `^x.y.z` base, e.g. for majors): edit
    `package.json`, then `npm install`. The new range forces re-resolution.
  - **Within-range bump** (take "Wanted" from `npm outdated`):
    `npm update --save <pkg1> <pkg2> ...`. `--save` raises each `^` floor
    to the locked version, so `package.json` never claims support for
    versions nobody tested. **Plain `npm install` is a no-op** here — it
    only re-resolves when `package.json` changes or the lockfile is missing.
  - Floors left behind earlier (range below the locked version): raise them
    to `^<locked>` in the same sweep; the lockfile diff must then show only
    range lines, no resolved-version changes.
- `npm update` with no args re-resolves the whole tree, which
  **cascade-fails on `min-release-age=7`** if ANY package in the tree has a
  fresh release (`Found: <pkg>@undefined` for the fresh one and nothing
  moves). Always pass an explicit package list and exclude anything <7 days
  old. Check release dates with `npm view <pkg> time --json | tail`.
- Commit `package.json` (if edited) + `package-lock.json` (+ `.npmrc` if
  changed). The lockfile diff is the source of truth for what actually moved.
- Before bumping a build-chain package (Vite plugins, lint plugins):
  `npm view <pkg> peerDependencies` to confirm host compatibility.
- TypeScript defaults `types: []` (since TS 6), so browser code must not
  lean on implicit `@types/node`. Fix surfacing type errors with cross-env
  idioms — `ReturnType<typeof setTimeout>` instead of `NodeJS.Timeout`,
  `import.meta.env.DEV` instead of `process.env.NODE_ENV` — rather than
  adding `@types/node` to browser code.

## Go specifics

- `go get <module>@<version>` per module (or `go get -u ./...` for a full
  minor sweep), run from the repo root (it covers `api/` and `gateway/`), then `go mod tidy`. Commit `go.mod` + `go.sum`
  (at the repo root) together.
- Pion moves as a family — don't hand-pin one pion module against its
  siblings; let the resolver pick the coherent set.

## Docker image pins (compose, devcontainer, Dockerfiles)

- Everything is pinned deliberately — never `latest`. A pin bump is a real
  change: re-run the verify wave, and for Jellyfin see the rule above.
- Node (`Dockerfile` base image, `.nvmrc` for CI): track **active LTS**, not
  the newest major — check the Node release schedule at bump time.

## Commit format (per wave)

Branch: `chore/deps-<scope>` (or one shared `chore/update-dependencies` for
a sweep).

```
chore(deps): <scope summary>

<bullet list of bumps with from→to>

Verified: scripts/check.sh (ALL CHECKS PASSED; e2e: CI).
```

`e2e: CI` after `SKIP_E2E=1`; `e2e: @golden` after `E2E_GREP=@golden`.

Use a HEREDOC for the message so multi-line formatting survives.

## Regression handling

If a bump fails verify and bisect isolates it to one package: **revert that
one package only**, keep the rest of the wave. Park it as a `tech-debt` issue
(propose it first, see CLAUDE.md "Tracking"; ask with AskUserQuestion) with:

- exact failing scenario (test name + symptom)
- bisect range to narrow next attempt
- why the rest of the wave was worth keeping

Exact-pinned packages listed there are deliberate regression holds — before
widening one back to `^`, check the entry and confirm with the user (AskUserQuestion).

## Tool reminders

- Library docs: `mcp__context7__resolve-library-id` → `query-docs`. Not
  WebFetch.
- Shell: Bash tool (Git Bash). PowerShell needs per-execution approval.
- Don't read `.env`; override via env vars for verify runs.
