# StreamIQ

Multi-tenant media platform: users stream their home media (NAS/PC) from a
browser anywhere, with **zero router configuration** — WebRTC data-channel
tunnel to a home gateway, TURN fallback. Sensitive files never leave the
user's hardware.

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

**Where we are (2026-11-08):** the core works end to end with auth, tenancy,
pairing and TURN: streaming over the tunnel is proven on mobile (cellular) and on a
TV browser. What's weak: **gateway setup and management are clunky**, and the
**whole UI is only functional** (no design pass yet). Open work: `gh issue list`.
The paragraphs below record what is built ("item N" = the original MVP build order).

**POC (2026-07-08, GO).** Proven: cellular→home connectivity (86%
direct, cellular 100%), TURN fallback, 1080p+subtitles, seek, HEVC transcode
and remux over the tunnel, 4K feasible via ABR. Record: `docs/poc-connectivity-spike.md`.
POC code was deleted in item 5 PR A; git holds it. Still open: iOS Safari device
test, codec census over real libraries, Jellyfin NAS footprint + GPLv2 check.

**Item 1 — control-plane foundation.** Migration #1
(tenants/users/devices, now `gateways`), Firebase ID-token verification (FirebaseAdmin, same path
dev+prod), first-sign-in tenant provisioning, and the ONE EF global query filter
enforcing tenant isolation are in. Integration harness: Testcontainers Postgres +
Firebase Auth emulator, real tokens minted through the prod verify path; behaviors
covered by Reqnroll (isolation/provisioning/auth-reject) + xUnit edges. React:
Firebase sign-in + empty authed shell.

**Items 2+3 — pairing + broker.** **PR A
(onboarding):** migration #2, enrollment token → `/api/gateways/enroll` → credential,
authenticated `/api/gateways/ws` heartbeat, persistent 10-year gateway DTLS cert + state dir,
local gateway page (Host/Origin guard), Gateways list. **PR B (broker + pairing):**
tenant-scoped broker (`/api/broker/ws`, session routing), browser WebCrypto client key,
session-bound connection auth, commit/reveal comparison code approved on the gateway
page, allowlist, pins enforced both directions; protocol in `docs/protocol.md`.
**Item 4 — productized gateway** (pivoted from a Docker sidecar after a spike: on Docker
Desktop, a containerized gateway gets relayed on cellular). **PR A:** native binaries on GitHub Releases
(`gateway-v*` tag → `release-gateway.yml`), `install.sh`/`install.ps1` (install = update,
SHA256-checked), `gateway.env` config file, daily update *notice* (notify-only), version in heartbeat + Gateways list (migration #5), JSON logs.
User guide: `docs/install.md`. Dev ports moved to 18096 (Jellyfin) / 18097 (gateway page),
so an installed copy runs on the defaults alongside dev. **PR B:** Jellyfin credential without manual
steps (`gateway/internal/jellyfin`: wizard bootstrap on a fresh Jellyfin, else one admin login
on the local page; since #50 a non-admin viewer token, not an API key, in `state/jellyfin.json`),
`install/jellyfin-compose.yml` release asset (pin = `jellyfin.Image`, test-enforced; `gateway jellyfin up|upgrade`), local
page is now a status page (heartbeat, Jellyfin reachable/version/key, bootstrapped admin creds).

**Item 5 — streaming client** (consumption-only, functional UI). **PR A (watch it):** Gateways → Open → library /
series / episodes → hls.js player over the tunnel (custom loader), subtitles, resume
via Jellyfin UserData. The gateway owns the Jellyfin credential (since #50 the hidden
non-admin user `streamiq-viewer`'s token; dev: `scripts/setup-jellyfin.sh`, then Connect
Jellyfin on the dev page): it injects the token, pins the viewer user, lets only an
endpoint allowlist through, and redacts the token from playlists. All POC
paths are deleted. **PR B (trust it):** TURN (Cloudflare creds in prod,
coturn in dev; per-session since item 6), `connection_sessions` telemetry (migration #4, drops
the POC's `poc_connectivity`), privacy indicator (direct vs relayed); `?relay`
forces the relay path. **Hosting:** the root `Dockerfile` builds the SPA into the
API image (`wwwroot`, same origin, no CORS in prod); Railway Root Directory = repo root.
**Item 6 — hardening** (protocol in `docs/protocol.md`). **PR A:** signaling
rate limits (per client IP via `STREAMIQ_CLIENT_IP_HEADER` = Railway `X-Real-IP`, plus
per-socket message buckets, 10 s auth deadline), TURN creds minted per broker session
in `ready` and revoked at its end (`GET /turn` is gone; dev coturn uses TURN REST
`STREAMIQ_TURN_SECRET`), gateway revocation (`DELETE /api/gateways/{id}`: hash nulled, row
kept for telemetry, sockets + sessions closed). Removing a client on the gateway page
closes its open sessions (gateway-side `pc.Close()`; the API never knows client keys).
**Local-page secret:** the page no longer shows the Jellyfin admin password, only the path
of `state/jellyfin.json` (0600) holding it. LAN access to the page needs a token
(`state/page-token`; login link `state/page-link`, printed by the installer; loopback exempt).
Postgres backups: daily `pg_dump` → GCS (`db-backup.yml`), restore runbook `docs/db-recovery.md`.
**Glossary** (renamed 2026-11-02, migration #3): **gateway** = the home box that
tunnels Jellyfin (was "agent" / `Device`); **client** = a paired browser (was
"browser device"; its key = client key); **API** = the control plane (`backend/`,
`STREAMIQ_API_URL`). "Media server" means Jellyfin only; "relay" means TURN only.
Docs under `docs/superpowers/` keep the old words.
**Project name:** StreamIQ (was "r8er" until 2026-11-06). Code forms: `streamiq` (paths,
module, DB, binaries), `StreamIq` (.NET namespaces/types), `STREAMIQ_` (env vars); "StreamIQ"
in user-visible text. Don't reintroduce the old name (historical records such as
`docs/poc-connectivity-spike.md` keep it: those URLs/env vars really were `r8er`).

## Stack & layout

| Dir | What | Stack |
|---|---|---|
| `backend/` | Control plane: API + WebRTC signaling (one web app) | .NET 10, EF Core, Postgres |
| `frontend/` | Browser client | React + Vite + TypeScript |
| `gateway/` | Home gateway: tunnels local Jellyfin over WebRTC | Go + Pion |
| `e2e/` | The one E2E golden path: browser → broker → gateway → Jellyfin | Playwright + testcontainers-node |
| `scripts/` | `gen-test-media.sh` (ffmpeg fixtures) | bash |
| `dev/firebase/` | Auth emulator config for compose | — |

**Vertical slices** (code organized by feature, not by layer):
- API: `backend/src/StreamIq.Api/Features/<Slice>/<UseCase>.cs` — one static class per
  use case with `Map(app)` + its handler, request/response types inline; mapped
  explicitly in `Program.cs` (no MediatR, no assembly scanning). Shared kernel only:
  `Data/` (DbContext, entities, migrations, tenant filter) and `Auth/`.
- API tests mirror it: `tests/…/Features/<Slice>/` holds that slice's Reqnroll
  `.feature` + steps and xUnit tests together; `Infrastructure/` = fixture/factory/
  token minter; `Data/` = shared-kernel tests.
- Gateway: package per feature in `gateway/internal/<slice>/` with colocated `_test.go`;
  `cmd/gateway/main.go` is wiring only. Slices don't import each other except shared
  primitives (`identity`, `tunnel`, `pairing`).

Auth = Firebase (emulator in dev). Media engine = bundled Jellyfin (pinned
image). Hosting = Railway. TURN = Cloudflare (local coturn in dev).

## Commands

```bash
bash scripts/check.sh                   # GOLDEN PATH: all checks (mirrors CI). Run + read output before claiming done.
powershell -File scripts/dev.ps1        # run the app: emulator + backend (:5028) + frontend (:5173); Ctrl+C stops all
powershell -File scripts/prune-worktrees.ps1 [-DryRun]  # remove worktrees + local branches already on main (merged PR / no commits); skips dirty ones

docker compose up -d                    # deps: postgres, jellyfin, firebase auth emulator
docker compose --profile relay up -d    # + local coturn (force relay via iceTransportPolicy)
bash scripts/gen-test-media.sh          # generate dev-media/ fixtures (needs ffmpeg)

dotnet run --project backend/src/StreamIq.Api     # backend (or: dotnet watch)
dotnet test backend/StreamIq.slnx                 # backend tests (Testcontainers → needs Docker)
npm run dev --prefix frontend                 # frontend
npm run build --prefix frontend               # frontend build check
go run ./cmd/gateway                          # gateway (from gateway/; reads gateway/gateway.env from setup-jellyfin.sh)
go test ./...                                 # gateway tests (from gateway/)
npm test --prefix e2e                         # E2E golden path (Playwright + Chrome, Docker; ~30s)
npm run preview --prefix e2e [-- status|down]  # this worktree's stack on the LAN (HTTPS) for phone/TV tests; agents: follow the `preview` skill (docs/tools.md)
```

Env: no `.env` needed — defaults line up (backend `:5028`, frontend → `:5028`, auth →
emulator `:9099` in `vite dev`). DB comes from backend user-secrets
(`ConnectionStrings:Default`, e.g. a Railway dev instance); unset → compose Postgres.
Copy `.env.example` only to override.

## Machine notes

- Primary dev machine is Windows 10 + Git Bash + Docker Desktop (WSL2).
  Go 1.26, .NET 10 SDK, Node 24, Docker are present — gateway work runs locally
  now (the devcontainer remains for CI parity / clean-room builds).
- **Worktrees:** tests are isolated — `check.sh` / backend tests / e2e run concurrently
  across worktrees (random ports, per-checkout `e2e/.bin`; Docker image tags are still
  machine-wide, last build wins). The *dev* stack is not:
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
    normal / someday), `size:s|m|l|xl`. `needs-spec` = no acceptance criteria yet:
    don't start it. Template: `.github/ISSUE_TEMPLATE/task.md`.
  - One issue → one worktree thread → one PR. Branch `<type>/<n>-<slug>`
    (`fix/42-cert-rotation`); PR body `Fixes #<n>`. Multi-PR feature = parent issue
    (the spec) + sub-issues. Milestone = what's being worked toward now; no milestone
    = backlog. Not wanted anymore: close as *not planned* with a comment (why + what
    would bring it back); reopen instead of re-filing.
  - Before starting: `gh issue view <n>`, and check the issue has no linked PR (taken).
    Open a draft PR early so the issue shows it's taken.
  - Board: project "StreamIQ" (github.com/users/bifi627/projects/2). Move the issue
    with `bash scripts/issue-status.sh <n> "<status>"`: *Ready* when its spec is done,
    *In progress* when work starts, *In review* when the PR is ready. New issues and
    *Done* are automatic. Needs gh scope `project` (`gh auth refresh -s project`).
  - Label `agent` (owner only) starts an agent thread via T3 webhook: no acceptance
    criteria or `needs-spec` → refinement with the owner; Ready → build to a PR. The
    owner approves a spec by removing `needs-spec` (`docs/tools.md` has the wiring).
  - Found mid-task (no drive-by fixes): search `gh issue list --search …` for a
    duplicate, then **propose** the issue (title, labels, body) in chat; create it only
    after the owner approves.
  - Security-sensitive findings never go in a public issue (public repo): tell the owner.
- **Current state below is not a status log.** Don't append per-PR progress there (it
  was the merge-conflict hotspot); open work lives in `gh issue list`. Edit it only when
  a lasting fact changes (new item complete, new architecture piece).
- **Done means:** `scripts/check.sh` ran and its output was read; the changed flow was
  actually driven (curl / UI / test output shown); docs invalidated by the change updated
  in the same diff. "It should work" is not evidence.
- **Unit of work:** sized for human review (one reviewable PR), not session capacity.
  No drive-by fixes — unrelated improvements become new tasks.
- **Never satisfy a check by weakening it.** Diffs touching tests, lint config, or CI
  are called out explicitly and get elevated scrutiny.
- **New dependency = stated justification** in the PR/commit body. Lockfile diffs are
  review triggers.
- **Codegen direction (decided):** the WebRTC protocol (signaling messages, tunnel
  framing) is **contract-first** — schema in `docs/protocol.md` once designed, types
  generated/derived for C#, Go, TS. The HTTP API is **code-first** — ASP.NET → OpenAPI →
  generated TS client, once the frontend first consumes it.
- **Rule graduation:** correction → line here → check/codegen. When a rule becomes
  tooling, delete its prose from this file.
- **Deferred on purpose** (rule of two): templates, canonical example files, per-feature
  docs, fine-grained boundary rules. Feature #1 (POC) is built by hand and becomes the
  exemplar at feature #2 — do not scaffold these early.

## Non-negotiable conventions

- **`tenant_id` on every tenant-owned table**, enforced via one EF global
  query filter. Tenant isolation is the product's crown-jewel invariant;
  the signaling isolation tests matter more than any feature.
- **No dev-mode auth bypass, ever.** Same token-verification code path in
  dev and prod; only the issuer differs (Firebase emulator).
- **Never `latest`** for the Jellyfin image; update the pin deliberately.
- **Firebase UID is not a primary key** — own `users.id` (UUID) +
  `firebase_uid` column.
- **No PII in our DB** (email, name, photo, IPs): Firebase owns profile data, we keep only
  the pseudonymous `firebase_uid`. Account deletion must stay "Firebase delete + `DELETE`
  the tenant row" (every tenant-owned FK cascades). Rationale: #65.
- **CRUD stays boring** (plain EF Core, no repository ceremony). The
  cleverness budget goes to tunnel/signaling/gateway only. The owner works
  ponytail-style: laziest solution that works, stdlib first, shortest diff.
- **Connection telemetry is a deliverable**: every WebRTC session attempt
  logs direct-vs-relay, IPv4/v6, throughput to Postgres. Checkpoints read
  this table.
- Data-channel payloads are **chunked (~16–64KB) with backpressure**
  (`bufferedAmount` both ends) — never send whole segments as one message.
- **English-only UI** (#97): user-visible strings stay inline (no message map, no i18n
  library). Dates, times and numbers go through `Intl` / `toLocale*()` with the browser's
  default locale, never a hardcoded format or locale. A second language: #110.
- Deploys/publishing are human-approved; no real secrets exist in the repo.
