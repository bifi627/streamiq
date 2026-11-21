# StreamIQ

Multi-tenant media platform: users stream their home media (NAS/PC) from a
browser anywhere, with **zero router configuration** — WebRTC data-channel
tunnel to a home gateway, TURN fallback. Sensitive files never leave the
user's hardware.

**You own this code; you're not a guest in it.** You maintain StreamIQ alongside the
owner. Notice what's worse than it should be (bugs, misleading names, dead code, missing
tests, stale docs or rules, awkward designs, a spec that looks wrong) and **speak up,
unasked**. Staying silent is the failure; a proposal the owner turns down costs nothing.
How to raise it without scope creep: "Ownership in practice" under Working rules.

## Read this first

Direction and specs live in **GitHub Issues** (+ milestones): `gh issue list`. A
feature's spec is its issue (acceptance criteria + out of scope); a multi-PR
feature is a parent issue with sub-issues. No new spec files in the repo.

`docs/superpowers/` holds the founding design docs and per-feature specs up to
2026-11. They are **history, not authority**: don't plan from them or cite their
phasing, checkpoints or out-of-scope lists. The rules that still hold are in
"Non-negotiable conventions" below; protocol facts live in `docs/protocol.md`.

Tool/service inventory + every credential and how to rotate it: `docs/tools.md`.
**Update it in the same diff** whenever a tool/service or credential is added,
removed, or changed (new env secret, new image, new cloud service).

## Current state

**Where we are:** the core works end to end with auth, tenancy, pairing and TURN:
streaming over the tunnel is proven on mobile (cellular) and on a TV browser, and the
UI design pass (#93) is done. What's weak and what's next live on GitHub, not here:
the current milestone and the `p1`/`p2` issues (`gh issue list`).
How it's built, by area (auth/tenancy, pairing, broker, gateway, Jellyfin, web client,
hosting), with the paths, endpoints and decisions: `docs/architecture.md`. Read the
section for an area before changing it.

**Glossary** (renamed 2026-11-02, migration #3): **gateway** = the home box that
tunnels Jellyfin (was "agent" / `Device`); **client** = a paired browser (was
"browser device"; its key = client key); **API** = the control plane (`backend/`, being ported to `api/`,
`STREAMIQ_API_URL`); **broker** = the API's signaling endpoint (`/api/broker/ws` +
`/api/gateways/ws`); **local gateway page** = the page the gateway serves on the home
LAN (code: `localpage`); **web gateway page** = the web app's view of a gateway;
**gateway API** = endpoints the gateway serves under `/streamiq/*` over the tunnel
(#138; a session carries device = client key and user = `users.id` from the broker);
**tunnel** = the WebRTC connection from one client to one gateway, from the browser
opening `/api/broker/ws` until that socket closes: direct, relayed, or failed (one row in
`tunnels`); "session" stays only the protocol/code name of a tunnel's identity (the
`session` field, `gateway/internal/sessions`). "Media server" means Jellyfin only; "relay" means TURN only.
Player qualities (`profile.ts`): **Auto** = the default, capped from the measured
gateway → client throughput (#162); **Source** = no cap, remuxes what the capability
probe says this device decodes, transcodes the rest; **Raw** = opt-in setting, no probe:
every codec copied as-is, unchecked, no fallbacks (#164); the rungs (1080p/720p/480p)
cap size + bitrate. **Compatible mode** = per-device setting for old TVs: H.264 +
stereo AAC in .ts, at most 1080p; Source and Raw are off while it's on (#113).
**Data saver** = per-device Automatic/On/Off (Automatic = `saveData` or cellular): Auto
stays at 480p and the throughput test is 3 × 1 MiB (#291).
Docs under `docs/superpowers/` keep the old words.
**Project name:** StreamIQ (was "r8er" until 2026-11-06). Code forms: `streamiq` (paths,
module, DB, binaries), `StreamIq` (.NET namespaces/types), `STREAMIQ_` (env vars); "StreamIQ"
in user-visible text. Don't reintroduce the old name (historical records such as
`docs/poc-connectivity-spike.md` keep it: those URLs/env vars really were `r8er`).

## Stack & layout

| Dir | What | Stack |
|---|---|---|
| `backend/` | Control plane: API + WebRTC signaling (one web app); the slices not ported to `api/` yet | .NET 10, EF Core, Postgres |
| `api/` | The Go port of `backend/` (#725): serves its slices, proxies the rest to `backend/` in dev + e2e (`docs/architecture.md`) | Go, pgx, Postgres RLS, Firebase Admin SDK |
| `frontend/` | Browser client | React + Vite + TypeScript |
| `gateway/` | Home gateway: tunnels local Jellyfin over WebRTC | Go + Pion |
| `protocol/` | The broker's messages on both sockets, types only: used by the gateway (and the Go API); `scripts/gen-types.sh` (tygo) generates `frontend/src/generated/` from it and the ported REST slices | Go |
| `e2e/` | E2E specs on one stack, in parallel: `golden-path` (browser → broker → gateway → Jellyfin; its tunnels on Activity), `multi-user` (two users over the tunnel), `gateways` (the gateways page spec: rename, status, status dot, paired clients, member view, local-page Reject, a refused broker socket), `households` (the household page + no-household screen: members, roles, invites, join, switcher, an admin's household Activity; no gateway), `library` (home redirect, nav Library link, shared session, folder deep link + cache, Recently added, Continue watching, season tabs, watched marks), `player` (privacy badge, profile line, deep link + Back key, ±10 s / play-pause, quality, compatible mode, Auto on a slow link, data saver, audio, auto audio, subtitles, next episode), `screen` (Use as screen entry, Play on…, the phone remote's commands, two phones, closing; tag `@player`), `diagnostics` (the dock on the library: bar, request table + log, stays open; the /diagnostics report: probe, Test connection direct + forced relay with its `tunnels` row, Copy report, a never-paired browser), `shell` (sign-in, nav, not-found, PWA, Settings; TV mode: the first visit on a TV (webOS on, the Android TV question), the handoff page (QR code, Back), the Settings + nav TV subsets; no gateway), `chrome87` (the production build signs in on a pinned Chromium 87, the webOS engine; tag `@shell`), `compat` (the last released gateway, via `gh release download`, against this commit's API: online → smoke, `upgradeRequired` → "Update required", neither → fail). `test` comes from `fixtures.ts` (Jellyfin per worker: in CI started by global setup, locally only when a spec needs it; fixture media encoded once into `e2e/.bin/media-<hash>`; `paired` = signed-in browser + its own paired gateway); arrange state over the API with `helpers.ts`; the area tags are `allowedTags` in `e2e/.oxlintrc.json` | Playwright + testcontainers-node |
| `scripts/` | Dev + CI scripts (`check.sh`, `dev.ps1`, `gen-test-media.sh`, …) | bash / PowerShell |
| `dev/firebase/` | Auth emulator config for compose | — |

**Vertical slices** (code organized by feature, not by layer):
- API: `backend/src/StreamIq.Api/Features/<Slice>/<UseCase>.cs` — one static class per
  use case with `Map(app)` + its handler, request/response types inline; mapped
  explicitly in `Program.cs` (no MediatR, no assembly scanning). Shared kernel only:
  `Data/` (DbContext, entities, migrations, tenant filter) and `Auth/`.
- API tests mirror it: `tests/…/Features/<Slice>/` holds that slice's Reqnroll
  `.feature` + steps and xUnit tests together; `Infrastructure/` = fixture/factory/
  token minter; `Data/` = shared-kernel tests.
- Go API: package per slice in `api/internal/<slice>/` (one file per use case, request/
  response types inline, colocated `_test.go` on `apitest`), shared kernel `db` (pool +
  `InTenant`, the one place the tenant is set), `auth`, `apitest`; `api/cmd/api/main.go`
  wiring only; schema = numbered SQL in `api/migrations/`. Slices don't import each other.
- Gateway: package per feature in `gateway/internal/<slice>/` with colocated `_test.go`;
  `cmd/gateway/main.go` is wiring only. Slices don't import each other except shared
  primitives (`identity`, `tunnel`, `pairing`).

Auth = Firebase (emulator in dev). Media engine = bundled Jellyfin (pinned
image). Hosting = Railway. TURN = Cloudflare (local coturn in dev).

## Commands

```bash
bash scripts/check.sh                   # GOLDEN PATH: all checks (mirrors CI). Run + read output before claiming done.
E2E_GREP='@player|@library' bash scripts/check.sh  # same, e2e only for the area tags the change touched (a build's default)
SKIP_E2E=1 bash scripts/check.sh        # same, no e2e stage: a change without e2e impact (CI still runs every spec)
powershell -File scripts/dev.ps1        # run the app: emulator + Go API (:5028) in front of the .NET API (:5029) + frontend (:5173); Ctrl+C stops all
powershell -File scripts/prune-worktrees.ps1 [-DryRun]  # remove worktrees + local branches already on main (merged PR / no commits); skips dirty ones
bash scripts/issue-lint.sh              # open issues breaking a tracking rule (labels, needs-spec vs AC, board column); exit 1 on findings, fixes nothing
bash scripts/gen-types.sh [--check]     # frontend/src/generated/ from protocol/ + the ported API slices (tygo); --check: fail when stale

docker compose up -d                    # deps: postgres, jellyfin, firebase auth emulator
docker compose --profile relay up -d    # + local coturn (force relay via iceTransportPolicy)
bash scripts/gen-test-media.sh          # generate dev-media/ (movies) + dev-shows/ (a series) fixtures (needs ffmpeg)

dotnet run --project backend/src/StreamIq.Api     # .NET API on :5029 (or: dotnet watch); the SPA needs the Go API in front (dev.ps1)
go run ./api/cmd/api                              # Go API on :5028 (dev.ps1 sets its env: STREAMIQ_ENV=development, STREAMIQ_APP_DB_PASSWORD, FIREBASE_*, STREAMIQ_LEGACY_API_URL, STREAMIQ_API_ADDR)
bash scripts/test-api.sh [-race]                  # Go API tests: one Postgres + Firebase emulator for the run (Docker)
dotnet test backend/StreamIq.slnx                 # backend tests (Testcontainers → needs Docker)
npm run dev --prefix frontend                 # frontend
npm run build --prefix frontend               # frontend build check
go run ./cmd/gateway                          # gateway (from gateway/; reads gateway/gateway.env from setup-jellyfin.sh)
go test ./...                                 # gateway tests (from gateway/; the module's go.mod is at the repo root)
npm test --prefix e2e                         # E2E specs (Playwright + Chrome, Docker; 4 workers locally, `-- --workers N` overrides)
npm test --prefix e2e -- --grep @households   # one area only (tags: `allowedTags` in e2e/.oxlintrc.json); no Jellyfin unless the area needs it
npm run preview --prefix e2e [-- status|down]  # this worktree's stack on the LAN (HTTPS) for phone/TV tests; owner: `/preview [tunnel]` / `/preview stop` (skill; docs/tools.md)
```

Env: no `.env` needed — defaults line up (Go API `:5028` in front of .NET `:5029`, frontend → `:5028`, auth →
emulator `:9099` in `vite dev`). DB comes from backend user-secrets
(`ConnectionStrings:Default`, e.g. a Railway dev instance); unset → compose Postgres.
Copy `.env.example` only to override.

## Machine notes

- Primary dev machine is Windows 10 + Git Bash + Docker Desktop (WSL2).
  Go 1.27, .NET 10 SDK, Node 26, Docker are present — gateway work runs locally
  now (the devcontainer remains for CI parity / clean-room builds).
- **Worktrees:** tests are isolated — `check.sh` / backend tests / e2e run concurrently
  across worktrees (random ports, per-checkout `e2e/.bin`; the test Firebase emulator image is
  shared, tagged by a hash of `dev/firebase`). The *dev* stack is not:
  compose (`name: streamiq`, fixed ports) and `dev.ps1` (:5028/:5173) are one per machine,
  shared by all worktrees (emulator users live in the `streamiq_firebase-data` volume,
  not in a checkout). Fresh worktree: `check.sh` runs `npm ci` itself.
- `.slnx` (not `.sln`) — .NET 10's solution format.
- `frontend/.npmrc` hardens npm: `ignore-scripts=true`, `min-release-age=7`.
  Keep this in every new package dir (e2e/ etc.). If `npm install` fails
  with `vite@undefined`-style ERESOLVE, a pinned version is younger than
  7 days — relax the semver range, don't remove the hardening.

## Working rules (harness — rationale in `docs/ai-harness-playbook.md`)

- **Ready before code:** a task has acceptance criteria + an explicit out-of-scope list.
- **Tracking = GitHub Issues** (bugs, tech debt, ideas, features; no tracking files).
  - Labels: one type (`bug` / `tech-debt` / `idea`), `area:*`, `p1`–`p3` (soon /
    normal / someday), `size:s|m|l|xl`. `needs-spec` = the owner hasn't approved the
    spec yet (missing or only drafted): don't start it. Template: `.github/ISSUE_TEMPLATE/task.md`.
  - `device:tv` / `device:phone` = can't be finished without a test on the owner's TV /
    a real phone (both if it needs both). Only for technical issues and UI edge cases that
    resizing the desktop window (or devtools device mode) can't reproduce: TV browser quirks,
    real phone browsers (iOS Safari, Android Chrome), real mobile networks (cellular, relay).
    Layout alone never gets it. Its PR stays a **draft** carrying the same label(s) until the
    owner has run the device test (`gh pr list --label device:tv`; `/preview tunnel`).
    Work doable away from home: `gh issue list --search "-label:device:tv -label:device:phone -label:needs-spec"`.
  - One issue → one worktree thread → one PR. Branch `<type>/<n>-<slug>`
    (`fix/42-cert-rotation`); PR body `Fixes #<n>`. PR title = a conventional commit
    (`fix: …`, `feat(scope): …`); it becomes the squash commit subject, which versions the
    gateway release (#274): a change that breaks installed gateways (gateway↔API protocol,
    `gateway.env`, state dir, CLI) gets `!` right after the type (`feat!: …`). Multi-PR feature = parent issue
    (the spec) + sub-issues. Milestone = what's being worked toward now; no milestone
    = backlog. Not wanted anymore: close as *not planned* with a comment (why + what
    would bring it back); reopen instead of re-filing.
  - **Group related issues** under a parent (sub-issues, order stated in the parent) when
    they touch the same code or build on each other, even if each is one PR. A group
    runs as one orchestrator thread on the parent, one sub-issue at a time: the owner
    merges each PR before the next one starts.
  - **Issue work goes through the skills**, also when asked in chat: `refine-issue` turns an
    issue into an approved spec (or splits it into a group), `build-issue` takes an approved
    one to a PR (taken-check, early draft PR, the posted agent review, device
    ending), `agent-issue`
    picks between them by the issue's state and orchestrates a group. Agents never merge.
  - Board: project "StreamIQ" (github.com/users/bifi627/projects/2). The skills move the
    card with `bash scripts/issue-status.sh <n> "<status>"` (*Ready*, *In progress*,
    *In review*); new issues and *Done* are automatic. Needs gh scope `project`
    (`gh auth refresh -s project`).
  - Label `agent` (owner only) starts an agent thread via T3 webhook: on an issue the
    `agent-issue` skill, on a PR the `agent-pr` skill (review, comments only). A build
    runs that review on its own PR as its last step, so the label on a PR is for PRs no
    agent built and for re-reviews. The owner
    approves a spec in the refinement thread or by removing `needs-spec` by hand.
    Unresolved `[blocker]`/`[spec]` review threads and red CI block the merge (ruleset on `main`);
    the owner can arm auto-merge per PR (`gh pr merge N --auto --squash`).
    Wiring: `docs/tools.md`.
  - **Agent signature:** the agent posts with the owner's login, so everything it writes
    on GitHub says so. Every comment, review, review comment and reply starts with the line
    `<!-- streamiq-agent -->` and its text starts with `🤖 <model> · ` (`🤖 Opus 5.5 · **[blocker]** …`),
    `<model>` = the agent's own model name as its system prompt states it. A PR or issue
    body it writes or rewrites ends with the line
    `🤖 Written by an agent (<model>) <!-- streamiq-agent -->` (once; a rewrite updates the model).
  - In chat, every issue/PR number is a markdown link, never a bare `#N`:
    `[#193](https://github.com/bifi627/streamiq/issues/193)` (`/issues/N` redirects to PRs too).
    On GitHub itself `#N` autolinks.
  - **Ownership in practice:** inside the task, fix it in the diff. Outside it, propose
    it as below (no drive-by fix, and don't drop it either). Rank by impact: lead with at
    most 3, nits in one line. Disagree once, with your pick and how sure you are; once the
    owner decides, build it fully and don't re-argue. The harness counts too: if
    CLAUDE.md, a skill or `check.sh` steered you wrong, propose the fix. End every task
    report (and a built PR's `## Noticed` section) with what you noticed but didn't touch.
  - Found mid-task (no drive-by fixes): search `gh issue list --search …` for a
    duplicate, then **propose** the issue (title, labels, body) in chat; create it only
    after the owner approves. Ask in the same message whether the spec is approved too:
    yes → create it without `needs-spec` and move it to *Ready*.
  - Security-sensitive findings never go on GitHub (public repo: no issue, PR body, review or
    comment): tell the owner, only in the thread.
- **Current state above and `docs/architecture.md` are not a status log.** Don't append
  per-PR progress there (it was the merge-conflict hotspot); open work lives in
  `gh issue list`. Edit them only when a lasting fact changes (new area complete, new
  architecture piece goes in `docs/architecture.md`).
- **Done means:** `scripts/check.sh` ran and its output was read (its e2e stage narrowed
  to the touched areas with `E2E_GREP`, or `SKIP_E2E=1` for a change without e2e impact;
  the full local e2e run, a Jellyfin per worker, only when the owner asks); the changed flow was
  actually driven (curl / UI / test output shown); docs invalidated by the change updated
  in the same diff. "It should work" is not evidence.
- **Questions to the owner go through `AskUserQuestion`** (2–4 options, your pick first),
  not a question at the end of a chat message; context goes in chat before it. Plain chat
  only when the tool isn't there.
- **Unit of work:** sized for human review (one reviewable PR), not session capacity.
  No drive-by fixes — unrelated improvements become new tasks.
- **Never satisfy a check by weakening it.** Diffs touching tests, lint config, or CI
  are called out explicitly and get elevated scrutiny.
- **New dependency = stated justification** in the PR/commit body. Lockfile diffs are
  review triggers.
- **Rule graduation:** correction → line here → check/codegen. When a rule becomes
  tooling, delete its prose from this file. After fixing a bug, ask whether a rule of a
  linter we already have would have caught it; yes → propose a `tech-debt` issue for it
  ("Found mid-task"), never a config change in the fix (`build-issue` does it for bug
  issues and review blockers; #556).
- **Deferred on purpose** (rule of two): templates, canonical example files, per-feature
  docs, fine-grained boundary rules. Add one only when a second real case needs it.

## Non-negotiable conventions

- **`tenant_id` on every tenant-owned table**, enforced via one EF global
  query filter in the .NET API and by Postgres row-level security in the Go API
  (`docs/architecture.md`; `api/internal/db` isolation tests). Tenant isolation is the product's crown-jewel invariant;
  the signaling isolation tests matter more than any feature. Bypasses
  (`IgnoreQueryFilters`, raw SQL) only in files on `scripts/tenant-filter-allowlist.txt`
  (enforced by `check.sh`).
- **No dev-mode auth bypass, ever.** Same token-verification code path in
  dev and prod; only the issuer differs (Firebase emulator).
- **Never `latest`** for the Jellyfin image; update the pin deliberately.
- **Firebase UID is not a primary key** — own `users.id` (UUID) +
  `firebase_uid` column.
- **No PII in our DB** (email, name, photo, IPs): Firebase owns profile data, we keep only
  the pseudonymous `firebase_uid`. Account deletion must stay "Firebase delete + `DELETE`
  the users row (cascades its memberships) + every household left without members"
  (every tenant-owned FK cascades from the tenant row). Rationale: #65, #92.
- **CRUD stays boring** (plain EF Core, no repository ceremony). The
  cleverness budget goes to tunnel/signaling/gateway only. The owner works
  ponytail-style: laziest solution that works, stdlib first, shortest diff.
- **Tunnel telemetry is a deliverable**: every tunnel
  logs direct-vs-relay, IPv4/v6, bytes, duration, throughput to Postgres. The broker
  writes the row and its end, the gateway reports route + bytes, the browser adds only
  its measured throughput (#390). Checkpoints read this table.
- Data-channel payloads are **chunked (~16–64KB) with backpressure**
  (`bufferedAmount` both ends) — never send whole segments as one message.
- **English-only UI** (#97): user-visible strings stay inline (no message map, no i18n
  library). Dates, times and numbers go through `Intl` / `toLocale*()` with the browser's
  default locale, never a hardcoded format. A second language: #110.
- **Frontend decision logic lives in `.ts`** (#532): a choice over state, an error, time or
  ordering goes in a plain `.ts` beside the component with a `node --test`; the `.tsx` only
  wires it (render branching stays). oxlint `complexity` ≤ 12 on `.tsx` enforces part of it.
  The Go limit (gateway and Go API): golangci-lint `gocyclo` > 15 fails (#542;
  tests excluded). Split into pieces that take and return values; a new `//nolint:gocyclo`
  names the issue that splits it or the reason it stays.
  Size limits (#600, code lines: blank and comment lines skipped, tests excluded): a
  function over 150 lines in the frontend (oxlint `max-lines-per-function`) or 80 in Go
  (gateway and Go API, golangci-lint `funlen`) fails, and so does a source file over 500 in any stack
  (`scripts/check-file-size.sh`; migrations and generated files excluded). Split along a
  real seam, never `Part1`/`Part2`. An exemption (`max-lines-per-function` in the disable
  comment, `//nolint:funlen // #N`, a line in `scripts/file-size-allowlist.txt`) names the
  issue that removes it or the reason it stays.
- **Comments say what the code can't**; try a better name or an extracted function first.
  Keep a non-obvious *why*: external quirk, invariant, security reason, units/protocol facts,
  `ponytail:` ceiling, lint exemption, short Go doc comments. Cut restating, history ("was X"),
  commented-out code, copies of `docs/`, banners. Issue numbers only as `TODO(#N)`, on a
  `nolint` / `oxlint-disable` line, or `quirk(#N): …`. TS: oxlint `streamiq/no-low-value-comments`
  (`frontend/lint/streamiq.js`) catches issue refs, banners, name-restating, the usual
  commented-out shapes and comments over 6 lines outside the file header; CSS, Go (gateway, Go API, every
  Go file), C# and scripts: `scripts/check-comments.sh` against `scripts/comment-baseline.txt` (issue refs,
  > 30 % comments); Go commented-out code: golangci-lint gocritic `commentedOutCode`. The rest
  needs reading.
- Deploys/publishing are human-approved; no real secrets exist in the repo.
