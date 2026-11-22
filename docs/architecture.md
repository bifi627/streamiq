# Architecture

How StreamIQ is built today, by area: the paths, endpoints and decisions a change in that
area needs. Terms are in the `CLAUDE.md` glossary; the wire protocol is in
`docs/protocol.md`. Update the section a change touches when a lasting fact changes. This
is not a status log: open work lives in `gh issue list`, history in git.

## Go API (`api/`: #725)

- The one API in production, dev (`scripts/dev.ps1`) and the e2e stack: every `/api` route, the
  broker's two sockets, `/healthz` and, with `STREAMIQ_WEB_DIR` set (the image), the
  built web app.
- Layout: `api/cmd/api/main.go` (wiring only), `api/migrations/` (numbered plain SQL),
  `api/internal/{db,auth,apitest,iplimit}` (shared kernel) and one package per slice (`me`, `broker`, `turn`,
  `gateways`, `onboarding`, `tunnels`, `household`, `members`, `invites`; `gateways` → `broker` (a revoke closes the sockets) and `broker` → `turn` are the
  only imports between slices);
  `front` is `/healthz`, CORS, the security headers (`nosniff`, `strict-origin-when-cross-origin`
  and a Content-Security-Policy, on every response) and the web app (a file that
  exists, else `index.html` for a path without an extension; `/api/*` stays a 404). The policy
  comes from `frontend/src/csp.ts` (own origin, Firebase sign-in, `blob:` media/workers/posters,
  nothing inline): Vite sends it from `vite dev` (wider: inline scripts and styles, the HMR
  socket) and `vite preview`, and writes the build's into `csp.txt`, which `front` sends with
  the web app (the API won't start without it); without a web app it is
  `frame-ancestors 'none'`. E2E fails a test on a CSP violation in its browsers. `pgx` with hand-written SQL, no ORM;
  names are snake_case and unquoted.
- **Migrations**: `api/migrations` runs each file once, in name order, each in its own
  transaction, as the tables' owner (`DATABASE_URL`), recorded in `schema_migrations`.
  `0001_baseline.sql` is the EF schema as `pg_dump` wrote it, with EF's history rows; on
  a database EF already migrated (a backup from before the cutover) it is recorded, not
  run. `0007_snake_case.sql` renames EF's PascalCase columns, constraints and indexes to
  snake_case and drops `__EFMigrationsHistory`.
- **Tenant isolation is Postgres row-level security** (`0002_rls.sql`): every
  tenant-owned table has a policy `tenant_id = app_tenant()` (`USING` + `WITH CHECK`) for
  the role `streamiq_app`, which owns no table; `app_tenant()` reads `app.tenant_id`,
  NULL when unset, so no tenant = no rows. The API connects as `streamiq_app` (its
  password `STREAMIQ_APP_DB_PASSWORD`, set at start by the owner) and sets the tenant
  per transaction only, in `db.InTenant` (or `db.InClaimedTenant`, whose tenant comes from a
  claim in the same transaction). Lookups that run before the tenant is known are
  `SECURITY DEFINER` functions limited by their argument (`memberships_of(user)`,
  `gateway_by_credential(hash)` for the gateway socket, `claim_enrollment_token(hash)`
  for enrollment, which also spends the token, `invite_by_hash(hash)` for an invite's
  preview, `claim_invite(hash)` for accept and `create_household(user)` for a new
  household with its first membership, `0005_households_invites.sql`; `sign_in(firebase uid)`
  finds or adds the user, `0006_rls_tenants_users.sql`). `tenants` has the same policy on
  its own `id`, and `streamiq_app` may not insert or delete one; `users` is read only:
  the members of the transaction's tenant, written only by `sign_in`. Every timestamp scans as UTC (`db.Connect`), so
  the JSON ends in `Z`.
- **Auth** (`api/internal/auth`): the Firebase Admin SDK verifies ID tokens, one call
  for the emulator and production; the emulator only with `STREAMIQ_ENV=development`.
  First sign-in adds the `users` row (`sign_in`; `ON CONFLICT` settles concurrent ones); the
  household rule is below. `auth.Profiles` reads aliases and emails from Firebase per
  request (one call, at most 100 users), never stored.
- Tests: `scripts/test-api.sh` starts one Postgres + emulator for the run; each package
  makes its own database (`apitest`), or starts its own pair when run alone. The
  isolation tests (`db`) run every rule against `streamiq_app` and, failing on purpose,
  against the owner. Listen address: `STREAMIQ_API_ADDR`, else `:$PORT`.

## Auth and tenancy

- Firebase ID tokens verified by FirebaseAdmin, one code path in dev and prod (emulator in
  dev). Own `users.id`, `firebase_uid` as a column.
- Tenant = **household**; isolation is row-level security in the Go API (above).
- `memberships` (tenant, user, role `admin`/`member`); a user can belong to several.
  Sign-up creates none: a user joins by invite or creates one (`POST /api/households`,
  becoming its admin). With none, only `/me`, invites and creating one work.
- Each HTTP request acts in one household, named by the `X-StreamIQ-Household` header
  (default: the oldest membership). The tenant is set only from the signed-in user's own
  membership (`auth.Handler` through `memberships_of`) or from a claim.
  A non-member gets `404` with header `X-StreamIQ-Not-Member` (same for a foreign or
  missing household).
- The membership's role is the request's `Caller.Role`. Adding and removing gateways (Go
  API) is admin-only, a member gets `403`; members list and open them.
- **Invites** (`api/internal/invites`): an admin makes a single-use 7-day link
  (`/join#<token>`, only the hash stored). Accepting adds the signed-in user as `member`;
  the token picks the household. Unknown, revoked, used and expired are one `404`.
- **Members** (`api/internal/members`): anyone lists (aliases from Firebase per call:
  `displayName` picked after sign-up, else the email; only your own email shown; members
  who show the same name get a short userId tag in the web app) and
  leaves; an admin removes and promotes/demotes. A household always keeps an admin
  (`409`; the check runs under a lock on the tenant row). A user left with no household
  stays without one. Removing a member deletes their pending invites in the same
  transaction. An admin names the household (`api/internal/household`).
- Tests: the Go API's (above), real emulator tokens through the prod verify path.

## Gateway onboarding and pairing

- Enrollment token → `/api/gateways/enroll` → gateway credential (`api/internal/onboarding`;
  the token is claimed before its household is known by the `SECURITY DEFINER` function
  `claim_enrollment_token`, in one transaction with the new gateway row); authenticated
  `/api/gateways/ws` heartbeat carries the gateway version (shown in the Gateways list).
  A dropped socket reconnects forever with backoff (1 s doubling to 30 s, reset after a
  healthy 30 s); each handshake times out after 20 s, so an unanswered upgrade retries.
- Persistent, non-expiring gateway DTLS cert in the state dir (`gateway reset-identity`
  replaces it).
- Pairing: browser WebCrypto client key, commit/reveal comparison code approved on the
  local gateway page, allowlist on the gateway, pins enforced in both directions.
- Revocation: `DELETE /api/gateways/{id}` nulls the credential hash, keeps the row for
  telemetry, closes its sockets and sessions. Removing a client on the local gateway page
  closes its open sessions (gateway-side `pc.Close()`; the API never knows client keys).

## Broker and signaling

- Messages: Go types in `protocol/` (types only: no pion, no database), used by the gateway;
  `scripts/gen-types.sh` (tygo, `scripts/tygo.yaml`) generates the web app's TypeScript from them
  and from the API slices listed there into `frontend/src/generated/`, committed; `check.sh` and CI
  fail when it is stale. The SDP and candidate are type parameters: pion's types in the
  gateway, the browser's `RTCSessionDescriptionInit` / `RTCIceCandidateInit` in the generated TS.
- Tenant-scoped broker in the Go API (`api/internal/broker`, `github.com/coder/websocket`):
  `/api/broker/ws` (one browser session to one gateway, the ID token in-band as the first
  message) and `/api/gateways/ws` (Bearer gateway credential). Its state (online gateways,
  live sessions) is in the process's memory: one API instance. A socket holds no database
  connection between messages; each write is one tenant transaction.
- The broker checks membership for the offered gateway's household, never one the
  browser names, and puts the user's `role` in the gateway's offer: gateway API routes registered
  `tunnel.AdminOnly` answer a member `403`.
- Rate limits: new sockets per client IP and minute, one budget with enrollment and
  enrollment tokens (`api/internal/iplimit`; `STREAMIQ_SIGNALING_PER_MINUTE`,
  `STREAMIQ_CLIENT_IP_HEADER` = Railway `X-Real-IP`; new invites and new households spend
  it too), per-socket
  message buckets (`golang.org/x/time/rate`), 10 s auth deadline.
- TURN (`api/internal/turn`): credentials minted per broker session in `ready` and revoked at its end; no
  standalone TURN endpoint. Cloudflare in prod; coturn in dev via TURN REST
  (`STREAMIQ_TURN_SECRET`). `?relay` forces the relay path; `?relay=tls` keeps only the
  `turns:…:443` URLs (TLS 443 relay, #576: checked by the prod smoke only, local coturn has no TLS).

## Tunnel telemetry

One row per tunnel in `tunnels`: the broker writes the row and its end, the gateway
reports route, bytes, what the tunnel was used for (playback / browsing / diagnostics /
management) and its active time, the browser adds only its measured throughput
(`PATCH /api/tunnels/{id}`, its own tunnel only). A stop (SIGTERM) closes every broker
socket through its normal cleanup within 8 s (`shutdownTimeout`): each open tunnel gets its
end and its TURN credential is revoked. A killed or crashed process can't: the next start
ends every row still open at its own start time (`api/internal/db`, one instance). During a
deploy the old one still runs: its rows are ended early, then stamped again by its own stop. The web app shows
a privacy indicator: on your network (the gateway sees the browser on one of its own subnets, `GET /streamiq/route`, #428), direct, or relayed.
A member's own tunnels in the household (30 days, ≤ 200) are on the Activity page
(`/activity`, `GET /api/tunnels`, `api/internal/tunnels`): use, route,
duration (the active time when reported), data, throughput, a failure in plain words; no
candidate types. Management and diagnostics rows hide behind a checkbox (remembered per browser) unless
they failed.
An admin's Activity opens on the whole household (`?scope=household`, admin only, rows carry
`userId`): a per-member summary over every row of the 30 days (`GET /api/tunnels/summary`:
tunnels, failures, relayed bytes), a member filter and a Member column,
names from the members endpoint ("Former member" / "Deleted account" otherwise).

**Gateway health** (#423): at telemetry `full` the heartbeat carries the box's health, kept
in `gateway_health` (`api/internal/broker`, `storeHealth`): a row when Jellyfin, OS/arch,
transcoding or the offline jail change, and at least every 5 min, at most one per 25 s; the latest row is the
current state. `gateways.telemetry` holds the level. Rows are kept (also after `off`).
The web gateway card shows the level; an admin switches it over the tunnel
(`POST /streamiq/telemetry`). Rows carry the gateway's version too (#424).
"Health, last 7 days" on the card (`HealthHistory.tsx`) reads `GET /api/gateways/{id}/health`
(`api/internal/gateways/health.go`, raw rows) when opened, from the API, so offline and
unpaired too; `health.ts` derives incidents (Jellyfin down, gaps over 10 min), version changes
and daily peaks per local day.

## Gateway (native binary)

- Native binaries, not a Docker sidecar: on Docker Desktop a containerized gateway gets
  relayed on cellular.
- Go module `streamiq` at the repo root (`go.mod`, `go.sum`, `.golangci.yml`): the gateway is
  `gateway/cmd` + `gateway/internal/<slice>`. Go commands name their tree or run from
  `gateway/`: `./...` from the root walks `frontend/` and `e2e/`'s `node_modules`.
- Released on GitHub Releases: a merge changing what the gateway builds with (`gateway/**`, repo
  packages it imports, its modules or the `go`/`toolchain` line in `go.mod`; `docs/tools.md`) auto-versions a release after
  green CI (`!` in the subject = minor bump; major = a hand-pushed `gateway-v*` tag;
  `release-gateway.yml`).
- `install.sh` / `install.ps1`: install = update, SHA256-checked. Config in `gateway.env`.
  Every update keeps the old binary and a state backup in `backups/` for
  `gateway rollback`. JSON logs. User guide: `docs/install.md`.
- CLI: spf13/cobra, wired in `cmd/gateway/commands.go` (#433): per-command help,
  shell completion, usage errors exit 2. No command = `run`; Explorer double-click
  runs it too (mousetrap off). The installers detect a binary that can back itself
  up by a `^  backup ` line in `gateway -h` (#296): keep that line.
- Daily update *notice* on every platform (log + local gateway page). On Windows with the
  logon task (`gateway service install`) a household admin can start the update from the
  gateway card; Linux/macOS update by hand.
- Dev ports 18096 (Jellyfin) / 18097 (local gateway page), so an installed copy runs on
  the defaults alongside dev.

## Local gateway page (`localpage`)

- Status page on the home LAN: heartbeat, Jellyfin reachable/version/credential,
  bootstrapped admin credentials. Host/Origin guard.
- LAN access needs a token (`state/page-token`; login link `state/page-link`, printed by
  the installer); loopback is exempt.
- Never shows the Jellyfin admin password, only the path of `state/jellyfin.json` (0600)
  that holds it.
- `/libraries`: a managed Jellyfin's per-library Offline / Extras state, read live (nothing
  stored), with *Make offline* and an Extras toggle (`jellyfin/libraries.go`).

## Jellyfin integration (`gateway/internal/jellyfin`)

- Credentials without manual steps: wizard bootstrap on a fresh Jellyfin, else one admin
  login on the local gateway page. Stored in `state/jellyfin.json`.
- One hidden non-admin viewer per user, `streamiq-<users.id>`, created on their first
  session; `streamiq-viewer` as the fallback. The gateway injects the session user's
  token, pins that viewer, lets only an endpoint allowlist through, and redacts the token
  from playlists. Dev: `scripts/setup-jellyfin.sh`, then Connect Jellyfin on the dev page.
- `gateway/install/jellyfin-compose.yml` is a release asset; its pin = `jellyfin.Image`
  (test-enforced). `gateway jellyfin up|upgrade`.
- Offline jail: the shipped compose Jellyfin sits on an `internal` network, an
  `alpine/socat` forwarder publishes 8096. `gateway jellyfin offline on|off` toggles the
  `# streamiq:<name>` marked blocks (`offline.go`); `upgrade` migrates older files.
- `serverSteps` (like `configSteps`, against `/System/Configuration`) turns the Person TMDb
  fetchers off.

## Web client (`frontend/`)

- Gateways → Open → library / series / episodes → hls.js player over the tunnel (custom
  loader), subtitles, resume via Jellyfin UserData. Every Jellyfin request the client makes
  is a path builder in `features/library/jellyfin.ts`, mirroring the gateway allowlist
  (`scripts/check-jellyfin-paths.sh` fails on a Jellyfin path elsewhere); the HLS stream
  URL is the one PlaybackInfo returns (`TranscodingUrl`).
- Household context: Shell loads `/me` once per page load and shares it
  (`HouseholdContext`, `useHousehold()` in `features/households/household.ts`); a picker
  shows with more than one membership. The chosen household is per device
  (`localStorage`); `switchHousehold()` stores it and fully reloads `/` (closes tunnels,
  drops the old household's state). On `X-StreamIQ-Not-Member`, `authed()` (`api.ts`)
  drops the choice and reloads `/` with a notice.
- Design tokens and base styles (dark, pill buttons, one 3 px `:focus-visible` ring) in
  `frontend/src/index.css`, CSS that Chrome 87 / webOS reads. Shell nav, gateway chip.
- Per-device **TV mode** (`settings.ts`, `html.tv`); the user agent sets only its
  first-visit default (`tv.ts`: known TV → on, Android box → ask once, #309). Its routes
  are an allowlist (`tvRoute.ts`): any other route, unknown ones included, renders the
  handoff page (the URL to open on a phone or PC) and drops out of the nav. D-pad = arrow keys:
  `onKeyDown={arrowFocus}` (`frontend/src/focus.ts`) on a container.
- Library home (`features/library/Home.tsx`): Resume spot, Recently added, libraries.
  Artwork through `art.ts`: loads only on screen, cached per gateway in the Cache API,
  deleted on sign-out and household switch.

## Hosting and operations

- The root `Dockerfile` builds the SPA and the Go API into one distroless image, run as
  non-root (`/web`, same origin, no CORS in prod). Railway Root Directory = repo root.
- Postgres is a blue/green pair on Railway (`DB_LIVE` names the live one): daily `pg_dump`
  of the live one → GCS (`db-backup.yml`), restores into the idle one (`db-restore.yml`,
  weekly as the drill); runbook `docs/db-recovery.md`.

## Feasibility record

The POC (2026-07-08) proved cellular→home connectivity (86% direct, cellular 100%), TURN
fallback, 1080p + subtitles, seek, HEVC transcode and remux over the tunnel, and 4K via
ABR. Record: `docs/poc-connectivity-spike.md`.
