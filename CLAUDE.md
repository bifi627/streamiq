# StreamIQ

Multi-tenant media platform: users stream their home media (NAS/PC) from a browser anywhere,
with **zero router configuration**: a WebRTC data-channel tunnel to a home gateway, TURN
fallback. Sensitive files never leave the user's hardware.

**You own this code; you're not a guest in it.** Notice what's worse than it should be (bugs,
misleading names, dead code, missing tests, stale docs or rules, awkward designs, a spec that
looks wrong) and **speak up, unasked**: staying silent is the failure, a proposal the owner turns
down costs nothing. How without scope creep: "Ownership in practice" under Working rules.

## Read this first

Direction and specs live in **GitHub Issues** (+ milestones): a feature's spec is its issue
(acceptance criteria + out of scope), a multi-PR feature is a parent issue with sub-issues. No
new spec files in the repo. The rules that hold are below; protocol facts live in
`docs/protocol.md`.

Tool/service inventory + every credential and how to rotate it: `docs/tools.md`. **Update it in
the same diff** when a tool/service or credential is added, removed or changed (env secret,
image, cloud service).

## Current state

The core works end to end with auth, tenancy, pairing and TURN: streaming over the tunnel is
proven on mobile (cellular) and on a TV browser, and the UI design pass (#93) is done. What's
weak and next: the current milestone and the `p1`/`p2` issues, not here. How each area is built
(paths, endpoints, decisions): `docs/architecture.md`; read an area's section before changing it.

**Glossary:** **gateway** = the home box that tunnels Jellyfin; **client** = a paired browser
(its key = client key); **API** = the control plane (`api/`, `STREAMIQ_API_URL`); **broker** =
the API's signaling endpoint (`/api/broker/ws` + `/api/gateways/ws`); **local gateway page** =
the page the gateway serves on the home LAN (code: `localpage`); **web gateway page** = the web
app's page for one gateway (`/gateways/<id>`); a bare "gateway page" could be either, so say
which; **gateway API** = endpoints the gateway serves under `/streamiq/*` over the tunnel (#138;
a session carries device = client key and user = `users.id` from the broker); **tunnel** = the
WebRTC connection from one client to one gateway, from the browser opening `/api/broker/ws` until
that socket closes: direct, relayed, or failed (one line in the gateway's tunnel history);
"session" stays only the protocol/code name of a tunnel's identity (the `session` field,
`gateway/internal/sessions`). "Media server" means Jellyfin only; "relay" means TURN only.
**household** = the tenant: users who share gateways (code/DB: `tenants`, `tenant_id`; UI/API:
household); a user can belong to several. **admin** / **member** = a household role: an admin
manages gateways, invites, members and the household's name, a member streams; a household always
keeps an admin. **onboarding** = a gateway joining a household (enrollment token → gateway
credential); **pairing** = a client becoming trusted by one gateway (client key, comparison code
approved on the local gateway page). **screen** = a TV in screen mode, remote-controlled by a
phone ("Play on…") through the same gateway; **TV mode** = the web app's layout for TV browsers,
not the same thing.
Player qualities (`profile.ts`): **Auto** = the default, capped from the measured gateway →
client throughput (#162); **Source** = no cap, remuxes what the capability probe says this device
decodes, transcodes the rest; **Raw** = opt-in setting, no probe: every codec copied as-is,
unchecked, no fallbacks (#164); the rungs (1080p/720p/480p) cap size + bitrate. **Compatible
mode** = per-device setting for old TVs: H.264 + stereo AAC in .ts, at most 1080p; Source and Raw
are off while it's on (#113). **Data saver** = per-device Automatic/On/Off (Automatic =
`saveData` or cellular): Auto stays at 480p and the throughput test is 3 × 1 MiB (#291).
**Project name:** StreamIQ (was "r8er" until 2026-11-06): `streamiq` in code (paths, module, DB,
binaries), `STREAMIQ_` for env vars, "StreamIQ" in user-visible text. Don't reintroduce the old
name; historical records (e.g. `docs/poc-connectivity-spike.md`) keep it: those URLs/env vars
really were `r8er`.

## Stack & layout

| Dir | What | Stack |
|---|---|---|
| `api/` | Control plane: every `/api` route + WebRTC signaling, `/healthz`, and in the prod image the built web app (`docs/architecture.md`) | Go, pgx, Postgres RLS, Firebase Admin SDK |
| `frontend/` | Browser client | React + Vite + TypeScript |
| `gateway/` | Home gateway: tunnels local Jellyfin over WebRTC | Go + Pion |
| `protocol/` | The broker's messages on both sockets, types only: used by the gateway (and the Go API); `scripts/gen-types.sh` (tygo) generates `frontend/src/generated/` from it and the API and gateway slices in `scripts/tygo.yaml` | Go |
| `e2e/` | E2E specs on one stack, in parallel, each `<name>.spec.ts` by area tag: `smoke` (@smoke), `lifecycle` + `gateways` (@gateways), `multi-user` (@gateways @player), `households` (@households), `library` (@library), `player` + `screen` (@player), `diagnostics` (@diagnostics), `shell` + `chrome87` (@shell), `compat` (@compat); what a spec covers is its header comment. `test` comes from `fixtures.ts` (Jellyfin per worker; `paired` = signed-in browser + its own paired gateway); arrange state over the API with `helpers.ts`; the area tags are `allowedTags` in `e2e/.oxlintrc.json` | Playwright + testcontainers-node |
| `scripts/` | Dev + CI scripts (`check.sh`, `dev.ps1`, `gen-test-media.sh`, …) | bash / PowerShell |
| `dev/firebase/` | Auth emulator config for compose | — |

**Vertical slices** (code organized by feature, not by layer):
- Go API: package per slice in `api/internal/<slice>/` (one file per use case, request/response
  types inline, colocated `_test.go` on `apitest`); shared kernel `db` (pool + `InTenant` /
  `InClaimedTenant`, the only places the tenant is set), `auth`, `apitest`, `iplimit` (the per-IP
  budget), `turn` (no routes, so kernel, not a slice); `api/cmd/api/main.go` wiring only; schema =
  numbered SQL in `api/migrations/`. Slices don't import each other (depguard `api-slices`).
- Gateway: package per feature in `gateway/internal/<slice>/` with colocated `_test.go`;
  `cmd/gateway/main.go` wiring only. Slices don't import each other except shared primitives
  (depguard `gateway-slices`).

Auth = Firebase (emulator in dev). Media engine = bundled Jellyfin (pinned image). Hosting =
Railway. TURN = Cloudflare (local coturn in dev).

## Commands

```bash
bash scripts/check.sh                   # GOLDEN PATH: all checks (mirrors CI). Run + read output before claiming done.
E2E_GREP='@player|@library' bash scripts/check.sh  # same, e2e only for the area tags the change touched (a build's default)
SKIP_E2E=1 bash scripts/check.sh        # same, no e2e stage: a change without e2e impact (CI still runs every spec)
powershell -File scripts/dev.ps1        # run the app: emulator + Go API (:5028) + frontend (:5173); Ctrl+C stops all
powershell -File scripts/prune-worktrees.ps1 [-DryRun]  # remove worktrees + local branches already on main (merged PR / no commits); skips dirty ones
bash scripts/issue-lint.sh              # open issues breaking a tracking rule (labels, needs-spec vs AC, board column); exit 1 on findings, fixes nothing
bash scripts/gen-types.sh [--check]     # frontend/src/generated/ from protocol/ + the API and gateway slices in scripts/tygo.yaml (tygo); --check: fail when stale

docker compose up -d                    # deps: postgres, jellyfin, firebase auth emulator
docker compose --profile relay up -d    # + local coturn (force relay via iceTransportPolicy)
bash scripts/gen-test-media.sh          # generate dev-media/ (movies) + dev-shows/ (a series) fixtures (needs ffmpeg)

go run ./api/cmd/api                              # Go API on :5028 (dev.ps1 sets its env: STREAMIQ_ENV=development, STREAMIQ_APP_DB_PASSWORD, FIREBASE_*, STREAMIQ_API_ADDR, DATABASE_URL)
bash scripts/test-api.sh [-race]                  # Go API tests: one Postgres + Firebase emulator for the run (Docker)
npm run dev --prefix frontend                 # frontend
npm run build --prefix frontend               # frontend build check
go run ./cmd/gateway                          # gateway (from gateway/; reads gateway/gateway.env from setup-jellyfin.sh)
go test ./...                                 # gateway tests (from gateway/; the module's go.mod is at the repo root)
go test ./gateway/internal/tunnel -run '^$' -fuzz '^FuzzJellyfinPolicy$' -fuzztime 5m -parallel 2 -fuzzminimizetime 2s  # fuzz one target, from the repo root (also FuzzServeFrame; sessions: FuzzAuthHandshake); findings land in testdata/fuzz/: commit each with its fix (a security-relevant one: tell the owner first, not on GitHub). Without -fuzzminimizetime it spends minutes shrinking inputs (0 execs/sec)
npm test --prefix e2e                         # E2E specs (Playwright + Chrome, Docker; 4 workers locally, `-- --workers N` overrides)
npm test --prefix e2e -- --grep @households   # one area only (tags: `allowedTags` in e2e/.oxlintrc.json); no Jellyfin unless the area needs it
npm run preview --prefix e2e [-- status|down]  # this worktree's stack on the LAN (HTTPS) for phone/TV tests; owner: `/preview [tunnel]` / `/preview stop` (skill; docs/tools.md)
```

Env: no `.env` needed, the defaults line up (Go API `:5028`, frontend → `:5028`, auth → emulator
`:9099` in `vite dev`). DB: `DATABASE_URL` (a `postgres://` URL, environment or `.env`, e.g. a
Railway dev instance); unset → compose Postgres. Copy `.env.example` only to override.

## Machine notes

- Windows 10 + Git Bash + Docker Desktop (WSL2), with Go 1.27 and Node 26: gateway work runs
  locally (the devcontainer remains for CI parity / clean-room builds).
- **Worktrees:** `check.sh` / API tests / e2e run concurrently across worktrees (random ports,
  per-checkout `e2e/.bin`; the test Firebase emulator image is shared, tagged by a hash of
  `dev/firebase`). The *dev* stack is one per machine, shared by all worktrees: compose
  (`name: streamiq`, fixed ports), `dev.ps1` (:5028/:5173), emulator users (volume
  `streamiq_firebase-data`). Fresh worktree: `check.sh` runs `npm ci` itself.
- `frontend/.npmrc` hardens npm (`ignore-scripts=true`, `min-release-age=7`): keep it in every
  package dir. `npm install` failing with a `vite@undefined`-style ERESOLVE = a pinned version is
  younger than 7 days: relax the semver range, don't remove the hardening.

## Working rules (harness — rationale in `docs/ai-harness-playbook.md`)

- **Ready before code:** a task has acceptance criteria + an explicit out-of-scope list.
- **Tracking = GitHub Issues** (bugs, tech debt, ideas, features; no tracking files).
  - Labels (the set: `scripts/issue-lint.sh`): `p1`–`p3` = soon / normal / someday. `needs-spec`
    = the owner hasn't approved the spec yet: don't start it. Template: `.github/ISSUE_TEMPLATE/task.md`.
  - `device:tv` / `device:phone` = can't be finished without a test on the owner's TV / a real
    phone (both if it needs both): only technical issues and UI edge cases that resizing the
    desktop window (or devtools device mode) can't reproduce: TV browser quirks, real phone
    browsers (iOS Safari, Android Chrome), real mobile networks (cellular, relay); never layout
    alone. Its PR stays a **draft** with the same label(s) until the owner has run the device
    test (`gh pr list --label device:tv`; `/preview tunnel`). Doable away from home:
    `gh issue list --search "-label:device:tv -label:device:phone -label:needs-spec"`.
  - One issue → one worktree thread → one PR. Branch `<type>/<n>-<slug>` (`fix/42-cert-rotation`);
    PR body `Fixes #<n>`. PR title = a conventional commit (`fix: …`, `feat(scope): …`): it
    becomes the squash commit subject, which versions the gateway release (#274); a change that
    breaks installed gateways (gateway↔API protocol, `gateway.env`, state dir, CLI) gets `!` right
    after the type (`feat!: …`). Milestone = what's being worked toward now; none = backlog. Not
    wanted anymore: close as *not planned* with why + what would bring it back; reopen, don't re-file.
  - **Group related issues** under a parent (sub-issues, order stated in the parent) when they
    touch the same code or build on each other, even if each is one PR. A group runs as one
    orchestrator thread on the parent, one sub-issue at a time: the owner merges each PR before
    the next one starts.
  - **Issue work goes through the skills**, also when asked in chat: `refine-issue` (approved
    spec, or a split into a group), `build-issue` (an approved issue to a PR), `agent-issue`
    (picks between them by the issue's state, orchestrates a group). Agents never merge.
  - Board: project "StreamIQ" (github.com/users/bifi627/projects/2). The skills move the card
    with `bash scripts/issue-status.sh <n> "<status>"` (*Ready*, *In progress*, *In review*); new
    issues and *Done* are automatic. Needs gh scope `project` (`gh auth refresh -s project`).
  - Label `agent` (owner only) starts an agent thread via T3 webhook: `agent-issue` on an issue,
    `agent-pr` (review, comments only) on a PR, which a build runs on its own PR anyway: the
    label is for PRs no agent built and for re-reviews. The owner approves a spec in the
    refinement thread or by removing `needs-spec`. Unresolved `[blocker]`/`[spec]` review threads
    and red CI block the merge (ruleset on `main`); the owner can arm auto-merge
    (`gh pr merge N --auto --squash`). Wiring: `docs/tools.md`.
  - **Agent signature:** the agent posts with the owner's login, so everything it writes on
    GitHub says so. Every comment, review, review comment and reply starts with the line
    `<!-- streamiq-agent -->`, its text with `🤖 <model> · ` (`🤖 Opus 5.5 · **[blocker]** …`),
    `<model>` = the agent's own model name as its system prompt states it. A PR or issue body it
    writes or rewrites ends with the line `🤖 Written by an agent (<model>) <!-- streamiq-agent -->`
    (once; a rewrite updates the model).
  - In chat, every issue/PR number is a markdown link, never a bare `#N`:
    `[#193](https://github.com/bifi627/streamiq/issues/193)` (`/issues/N` redirects to PRs too).
  - **Ownership in practice:** inside the task, fix it in the diff; outside it, propose it as
    below (no drive-by fix, and don't drop it either). Lead with at most 3 by impact, nits in one
    line. Disagree once, with your pick and how sure you are; once the owner decides, build it
    fully and don't re-argue. The harness counts too: if CLAUDE.md, a skill or `check.sh`
    steered you wrong, propose the fix. End every task report (and a built PR's `## Noticed`
    section) with what you noticed but didn't touch.
  - Found mid-task: search `gh issue list --search …` for a duplicate, then **propose** the issue
    (title, labels, body) in chat and ask in the same message whether its spec is approved too;
    create it only after the owner approves (spec approved → without `needs-spec`, on *Ready*).
  - Security-sensitive findings never go on GitHub (public repo: no issue, PR body, review or
    comment): tell the owner, only in the thread.
- **Current state above and `docs/architecture.md` are not a status log** (per-PR progress was
  the merge-conflict hotspot; open work lives in issues). Edit them only when a lasting fact
  changes (new area complete, new architecture piece in `docs/architecture.md`).
- **Done means:** `scripts/check.sh` ran and its output was read (e2e narrowed to the touched
  areas with `E2E_GREP`, or `SKIP_E2E=1` without e2e impact; the full local e2e run, a Jellyfin
  per worker, only when the owner asks); the changed flow was actually driven (curl / UI / test
  output shown); docs invalidated by the change updated in the same diff. "It should work" is
  not evidence.
- **Questions to the owner go through `AskUserQuestion`** (2–4 options, your pick first), not a
  question at the end of a chat message; context in chat before it. Plain chat only without the tool.
- **Unit of work:** one reviewable PR, not session capacity. No drive-by fixes: unrelated
  improvements become new tasks.
- **Never satisfy a check by weakening it.** Diffs touching tests, lint config or CI are called
  out explicitly and get elevated scrutiny.
- **New dependency = stated justification** in the PR/commit body. Lockfile diffs are review triggers.
- **Rule graduation:** correction → line here → check/codegen; once a check enforces a rule, its
  prose here shrinks to one line naming the check. After fixing a bug, ask whether a rule of a
  linter we already have would have caught it; yes → propose a `tech-debt` issue ("Found
  mid-task"), never a config change in the fix (`build-issue` does it for bug issues and
  review blockers; #556).
- **Deferred on purpose** (rule of two): templates, canonical example files, per-feature docs,
  fine-grained boundary rules. Add one only when a second real case needs it.

## Non-negotiable conventions

- **`tenant_id` on every tenant-owned table**, enforced by Postgres row-level security
  (`docs/architecture.md`; `api/internal/db` isolation tests). Tenant isolation is the crown-jewel
  invariant; the signaling isolation tests matter more than any feature. The tenant is set only
  in `db.InTenant` / `db.InClaimedTenant`; a lookup before it is known is a `SECURITY DEFINER`
  function limited by its argument.
- **No dev-mode auth bypass, ever.** Same token-verification code path in dev and prod; only the
  issuer differs (Firebase emulator).
- **Never `latest`** for the Jellyfin image; update the pin deliberately.
- **Firebase UID is not a primary key**: own `users.id` (UUID) + `firebase_uid` column.
- **No PII in our DB** (email, name, photo, IPs): Firebase owns profile data, we keep only the
  pseudonymous `firebase_uid`. Account deletion stays "Firebase delete + `DELETE` the users row
  (cascades its memberships) + every household left without members" (every tenant-owned FK
  cascades from the tenant row). Rationale: #65, #92.
- **CRUD stays boring**: plain SQL on pgx, no ORM, no repository ceremony (SQL shape:
  `api/internal/db/sqlsource_test.go`). The cleverness budget goes to tunnel/signaling/gateway
  only. The owner works ponytail-style: laziest solution that works, stdlib first, shortest diff.
- **Tunnel history is a deliverable**: every tunnel that reaches a gateway is recorded in the
  gateway's own history (direct or relayed, IPv4/v6, bytes, duration, use, throughput;
  `state/history/`, 30 days): the gateway writes the line, the browser adds only its measured
  throughput over the tunnel. Activity reads it from the gateways. Postgres keeps only relayed
  bytes per gateway and month, from Cloudflare (`relay_usage`).
- Data-channel payloads are **chunked (~16–64KB) with backpressure** (`bufferedAmount` both
  ends): never whole segments as one message.
- **English-only UI** (#97): user-visible strings stay inline (no message map, no i18n library).
  Dates, times and numbers go through `Intl` / `toLocale*()` with the browser's default locale,
  never a hardcoded format (oxlint `streamiq/no-hardcoded-locale`). A second language: #110.
- **Frontend decision logic lives in `.ts`** (#532): a choice over state, an error, time or
  ordering goes in a plain `.ts` beside the component with a `node --test`; the `.tsx` only wires
  it (render branching stays; oxlint `complexity` on `.tsx` enforces part of it).
- **Small functions and files**, split along a real seam (never `Part1`/`Part2`): oxlint
  `complexity` / `max-lines-per-function`, golangci-lint `gocyclo` / `funlen`, `scripts/check-file-size.sh`.
- **Comments say what the code can't**; try a better name or an extracted function first. Keep a
  non-obvious *why*: external quirk, invariant, security reason, units/protocol facts,
  `ponytail:` ceiling, lint exemption, short Go doc comments. Cut restating, history ("was X"),
  commented-out code, copies of `docs/`, banners. Checks: oxlint `streamiq/no-low-value-comments`,
  `scripts/check-comments.sh`, gocritic `commentedOutCode`; the rest needs reading.
- Deploys/publishing are human-approved; no real secrets exist in the repo.
