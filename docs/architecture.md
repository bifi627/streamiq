# Architecture

How StreamIQ is built today, by area: the paths, endpoints and decisions a change in that
area needs. Terms are in the `CLAUDE.md` glossary; the wire protocol is in
`docs/protocol.md`. Update the section a change touches when a lasting fact changes. This
is not a status log: open work lives in `gh issue list`, history in git.

## Auth and tenancy

- Firebase ID tokens verified by FirebaseAdmin, one code path in dev and prod (emulator in
  dev). Own `users.id`, `firebase_uid` as a column.
- Tenant = **household**. Isolation is ONE EF global query filter on `tenant_id`.
- `memberships` (tenant, user, role `admin`/`member`); a user can belong to several.
  Sign-up creates none: a user joins by invite or creates one (`POST /api/households`,
  becoming its admin). With none, only `/me`, invites and creating one work.
- Each HTTP request acts in one household, named by the `X-StreamIQ-Household` header
  (default: the oldest membership). `CurrentTenantId` is set only from the signed-in
  user's own membership (`Auth/Households.cs`, the one cross-tenant membership lookup).
  A non-member gets `404` with header `X-StreamIQ-Not-Member` (same for a foreign or
  missing household).
- The membership's role is the request's `Role` claim. Adding and removing gateways is
  admin-only (`RequireRole`, a member gets `403`); members list and open them.
- **Invites** (`Features/Invites/`): an admin makes a single-use 7-day link
  (`/join#<token>`, only the hash stored). Accepting adds the signed-in user as `member`;
  the token picks the household.
- **Members** (`Features/Members/`): anyone lists (aliases from Firebase per call:
  `displayName` picked after sign-up, else the email; only your own email shown) and
  leaves; an admin removes and promotes/demotes. A household always keeps an admin
  (`409`; the check runs under a lock on the tenant row). A user left with no household
  stays without one.
- Tests: Testcontainers Postgres + Firebase Auth emulator, real tokens minted through
  the prod verify path; Reqnroll for isolation/provisioning/auth-reject, xUnit for edges.

## Gateway onboarding and pairing

- Enrollment token → `/api/gateways/enroll` → gateway credential; authenticated
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

- Tenant-scoped broker at `/api/broker/ws`, routing sessions to gateways; session-bound
  connection auth.
- The broker checks membership for the offered gateway's household, never one the
  browser names, and puts the user's `role` in the gateway's offer: gateway API routes registered
  `tunnel.AdminOnly` answer a member `403`.
- Rate limits: per client IP (`STREAMIQ_CLIENT_IP_HEADER` = Railway `X-Real-IP`), per-socket
  message buckets, 10 s auth deadline.
- TURN: credentials minted per broker session in `ready` and revoked at its end; no
  standalone TURN endpoint. Cloudflare in prod; coturn in dev via TURN REST
  (`STREAMIQ_TURN_SECRET`). `?relay` forces the relay path; `?relay=tls` keeps only the
  `turns:…:443` URLs (TLS 443 relay, #576: checked by the prod smoke only, local coturn has no TLS).

## Tunnel telemetry

One row per tunnel in `tunnels`: the broker writes the row and its end, the gateway
reports route and bytes, the browser adds only its measured throughput. The web app shows
a privacy indicator: on your network (the gateway sees the browser on one of its own subnets, `GET /streamiq/route`, #428), direct, or relayed.

## Gateway (native binary)

- Native binaries, not a Docker sidecar: on Docker Desktop a containerized gateway gets
  relayed on cellular.
- Released on GitHub Releases: a merge touching `gateway/**` auto-versions a release after
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
  (`scripts/check-jellyfin-paths.sh` fails on a Jellyfin path elsewhere).
- Household context: Shell loads `/me` once per page load and shares it
  (`HouseholdContext`, `useHousehold()` in `features/households/household.ts`); a picker
  shows with more than one membership. The chosen household is per device
  (`localStorage`); `switchHousehold()` stores it and fully reloads `/` (closes tunnels,
  drops the old household's state). On `X-StreamIQ-Not-Member`, `authed()` (`api.ts`)
  drops the choice and reloads `/` with a notice.
- Design tokens and base styles (dark, pill buttons, one 3 px `:focus-visible` ring) in
  `frontend/src/index.css`, CSS that Chrome 87 / webOS reads. Shell nav, gateway chip.
- Per-device **TV mode** (`settings.ts`, `html.tv`). D-pad = arrow keys:
  `onKeyDown={arrowFocus}` (`frontend/src/focus.ts`) on a container.
- Library home (`features/library/Home.tsx`): Resume spot, Recently added, libraries.
  Artwork through `art.ts`: loads only on screen, cached per gateway in the Cache API,
  deleted on sign-out and household switch.

## Hosting and operations

- The root `Dockerfile` builds the SPA into the API image (`wwwroot`, same origin, no CORS
  in prod). Railway Root Directory = repo root.
- Postgres backups: daily `pg_dump` → GCS (`db-backup.yml`); restore runbook
  `docs/db-recovery.md`.

## Feasibility record

The POC (2026-07-08) proved cellular→home connectivity (86% direct, cellular 100%), TURN
fallback, 1080p + subtitles, seek, HEVC transcode and remux over the tunnel, and 4K via
ABR. Record: `docs/poc-connectivity-spike.md`.
