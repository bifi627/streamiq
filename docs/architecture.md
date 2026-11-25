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
  `api/internal/{db,auth,apitest,iplimit,turn}` (shared kernel: no routes) and one package per slice (`me`, `broker`,
  `gateways`, `onboarding`, `relayusage`, `household`, `members`, `invites`; no imports between them, depguard
  `api-slices`: a revoke closes the broker's sockets through the `b.Revoke` that `main.go` hands to `gateways`);
  `front` is `/healthz`, CORS, the security headers (`nosniff`, `strict-origin-when-cross-origin`
  and a Content-Security-Policy, on every response) and the web app (a file that
  exists, else `index.html` for a path without an extension; `/api/*` stays a 404). The policy
  comes from `frontend/src/shared/csp.ts` (own origin, Firebase sign-in, `blob:` media/workers/posters,
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
  claim in the same transaction). Lookups that run before the tenant is known, or across
  the user's households, are `SECURITY DEFINER` functions limited by their argument
  (`memberships_of(user)`, `member_counts(user)` for `/api/me`,
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
- Gateway identity key in the state dir (`identity.pem`; `gateway reset-identity`
  replaces it); browsers pin it, and the gateway proves it in the `auth` channel's
  challenge. Each tunnel gets a fresh DTLS certificate (Pion's default), so tunnels
  aren't linkable by their certificate (#427).
- Pairing: browser WebCrypto client key, commit/reveal comparison code approved on the
  local gateway page and confirmed in the browser (It matches, #955), allowlist on the gateway, pins enforced in both directions.
- Revocation: `DELETE /api/gateways/{id}` nulls the credential hash, keeps the row,
  closes its sockets and sessions. Removing a client on the local gateway page
  closes its open sessions (gateway-side `pc.Close()`; the API never knows client keys).

## Broker and signaling

- Messages: Go types in `protocol/` (types only: no pion, no database), used by the gateway;
  `scripts/gen-types.sh` (tygo, `scripts/tygo.yaml`) generates the web app's TypeScript from them
  and from the API and gateway slices listed there (the gateway's: its `auth` channel and gateway API) into `frontend/src/generated/`, committed; `check.sh` and CI
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
  standalone TURN endpoint. Only for the gateway the browser names in `auth` (`gatewayId`), when it is a
  gateway of the user's households and not revoked, online or not (one that comes online right
  after `ready` still gets a relay), unless its relay is off (#785: the gateway's own setting in
  `state/gateway.json`, switched on the web gateway card over the tunnel or with `gateway relay
  on|off`, mirrored as `gateways.relay_off` from the heartbeat; the gateway also drops relay
  candidates itself, `docs/protocol.md`); else STUN only, and an offer to another gateway is refused. Each Cloudflare credential carries that gateway's
  random `gateways.relay_tag` as `customIdentifier` (relay usage, below). Cloudflare in prod; coturn in dev via TURN REST
  (`STREAMIQ_TURN_SECRET`). `?relay` forces the relay path; `?relay=tls` keeps only the
  `turns:…:443` URLs (TLS 443 relay, #576: checked by the prod smoke only, local coturn has no TLS).

## Tunnel history

The API keeps no per-tunnel data (#783): every tunnel is recorded on its gateway (below),
Postgres keeps only relayed bytes per gateway and month, from Cloudflare (relay usage,
below). What an older gateway still sends (its `tunnel` report, health, telemetry level)
the broker ignores. A stop (SIGTERM) closes every broker socket through its normal cleanup
within 8 s (`shutdownTimeout`): each open tunnel's TURN credential is revoked (its gateway
may not hear the `bye`: its socket closes too, and the tunnel ends when the browser's
connection drops). The web app shows
a privacy indicator: on your network (the gateway sees the browser on one of its own subnets, `GET /streamiq/route`, #428), direct, relayed, or relayed · forced (the tunnel was opened with this browser's Force relay on, #945).
**The tunnel history stays on the gateway** (#782, part of #768): `sessions` hands every
ended tunnel (`Sessions.Ended`: the report, its user, the offer's time, the throughput) to
`gateway/internal/history` (`Tunnels.Record`), one line in
`state/history/tunnels-YYYY-MM-DD.jsonl` (30 days kept), stamped with the gateway id: a
re-enrolled gateway (maybe in another household) answers none of its earlier lines. The browser posts its measured
throughput to its own tunnel (`POST /streamiq/tunnels/throughput`, `pairing/session.ts`,
kept on `tunnel.Usage`). A member's own tunnels to the household's gateways (30 days, ≤ 200
per gateway) are in the household details' Activity tile (`/settings/household`; `/activity`
redirects there with it open), read only once it is opened: `activity/api.ts` asks every gateway that
is online and paired with this browser (`GET /streamiq/tunnels` over the tunnel; those are
management tunnels) and `history.ts` merges the rows; any other gateway, or one that fails,
is named with "history unavailable". Use, route, duration (the active time when reported),
data, throughput, a failure in plain words; no candidate types. Management and diagnostics
rows hide behind a checkbox (remembered per browser) unless they failed.
An admin's Activity opens on the whole household (`?scope=household`, admin only, rows carry
`userId`): a per-member summary over every line of the 30 days (`GET
/streamiq/tunnels/summary` per gateway, added up per user: tunnels, failures, relayed
bytes), a member filter and a Member column, names from the members endpoint ("Former
member" otherwise).

**Relay usage** (#784, part of #768): what each household relays through Cloudflare TURN,
from Cloudflare's own numbers, so no gateway can under-report it. `api/internal/relayusage`:
a job in the API (a minute after start, then daily; only with `CLOUDFLARE_ACCOUNT_ID` +
`CLOUDFLARE_ANALYTICS_API_TOKEN`) reads `sum.egressBytes` per `customIdentifier` from the
GraphQL analytics (`callsTurnUsageAdaptiveGroups`) for this UTC month and the last, maps
each tag to its gateway (`gateway_by_relay_tag`, `SECURITY DEFINER`; an unknown tag is
skipped) and **sets** `relay_usage` (tenant, gateway, month, bytes; no FK to the gateway, so
a removed one's bytes stay). A failed run is logged and retried the next day. `GET
/api/relay-usage` (admin) is the household's rows, shown in Activity's admin summary
("Relayed through StreamIQ", `RelayUsage.tsx`) whether the gateways are online or not. Dev
and e2e (coturn): always empty.

**Gateway health** (#781, part of #768): the history stays on the gateway, never in the
API. The gateway records its health (`gateway/internal/history`, `Health.Record`, every 30 s
from `box.record`): a row when Jellyfin, OS/arch, transcoding, the offline jail or the
gateway version change, at least every 5 min, at most one per 25 s, in `state/history/health-YYYY-MM-DD.jsonl` (JSON Lines, one file per UTC
day, 7 days kept; `backup` carries the directory). "Health, last 7 days" on the card
(`HealthHistory.tsx`) reads only the gateway API `GET /streamiq/health` over the tunnel, when
opened: offline or from an unpaired browser it says why it can't show it (no API request).
`health.ts` derives incidents (Jellyfin down, gaps over 10 min), version changes and daily
peaks per local day.

## Gateway (native binary)

- Native binaries, not a Docker sidecar: on Docker Desktop a containerized gateway gets
  relayed on cellular.
- Go module `streamiq` at the repo root (`go.mod`, `go.sum`, `.golangci.yml`): the gateway is
  `gateway/cmd` + `gateway/internal/<slice>`. Go commands name their tree or run from
  `gateway/`: `./...` from the root walks `frontend/` and `e2e/`'s `node_modules`.
- `tunnel` is the shared primitive: the data-channel request/response, the Jellyfin proxy
  and the gateway API's `Router` (its own endpoints: burst, route). Each feature registers
  its endpoints in `cmd/gateway` wiring: the screen relay (`screen`, docs/protocol.md
  "Screens"), pairing, onboarding, update, history.
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
  The e2e and preview Jellyfin run jailed the same way (`e2e/stack.ts`, #942).
- `serverSteps` (like `configSteps`, against `/System/Configuration`) turns the Person TMDb
  fetchers off.

## Web client (`frontend/`)

- Layout of `frontend/src/`: the shell (`main.tsx`, `App.tsx`, `index.css`), `shared/`
  (modules two or more features import), `features/<feature>/` (`library`, `player`,
  `screen`, `tv`, …) and `generated/` (tygo output).

- Gateways → Open → library / series / episodes → hls.js player over the tunnel (custom
  loader), subtitles, resume via Jellyfin UserData. Every Jellyfin request the client makes
  is a path builder in `features/library/jellyfin.ts`, mirroring the gateway allowlist
  (`scripts/check-jellyfin-paths.sh` fails on a Jellyfin path elsewhere); the HLS stream
  URL is the one PlaybackInfo returns (`TranscodingUrl`).
- A network change (Wi-Fi ↔ cellular) kills a tunnel: there is no ICE restart. The library
  layout's hold on its shared tunnel (`features/pairing/hold.ts`) replaces it when it is
  failed or closed, or has been disconnected for more than 5 s. It retries for 60 s, then
  shows the error. The player keeps its engine and reloads at the playhead over the new
  pc. Each tunnel is its own history line.
- Household context: Shell loads `/me` once per page load and shares it
  (`HouseholdContext`, `useHousehold()` in `features/households/household.ts`); the households overview
  (`/settings/households`) lists every membership with Switch, the details page
  (`/settings/household`) is the active one's. The chosen household is per device
  (`localStorage`); `switchHousehold()` stores it and fully reloads (closes tunnels,
  drops the old household's state): Switch and the TV picker stay on a household-free page
  (`/settings*`, `/gateways`; `switchTarget.ts`), anything else reloads `/`. On `X-StreamIQ-Not-Member`, `authed()` (`shared/api.ts`)
  drops the choice and reloads `/` with a notice.
- Design tokens and base styles (dark, pill buttons, one 3 px `:focus-visible` ring) in
  `frontend/src/index.css`, CSS that Chrome 87 / webOS reads. Shell nav, gateway chip.
- App shell (`App.tsx` `Shell`, tabs in `shell.ts`, `Nav.tsx`): a top bar (logo, nav,
  gateway chip), a title row (back · title · actions) the page fills with `<PageBar>`
  (`shared/PageBar.tsx`, portals into the row) and on a phone (≤ 600 px) the nav as a bottom
  tab bar above the safe-area inset. Nav: Gateways · Library · Settings (Household and
  Activity are under Settings); TV mode's: Library and Settings. The player page
  (`/play/<id>`, TV mode's) hides all of it; elsewhere a title plays inline on its detail
  page (`/i/<id>?play=<id>`, an episode on its series' page; `playTarget` in `items.ts`).
- Connection badge (`features/gateways/Badge.tsx`), the top bar's right end: the active
  gateway (the route's, else the Library tab's) with its dot and the connection type
  (the player's `RouteBadge`). Library routes feed it from their live tunnel (`LiveRoute`);
  elsewhere one check tunnel per page load and gateway (connect, `/streamiq/route`, close),
  kept in the query cache (`['connection', id]`) until a library tunnel or a new pairing
  replaces it. Offline or no pin on this browser: no check ("Not paired").
- Gateways overview (`features/gateways/Gateways.tsx`, `OverviewCard.tsx`): a card per
  gateway, the **active gateway** first: the open route's, else the per-device last opened
  (`lastGateway` in `shared/settings.ts`, subscribable), else the first online
  (`libraryTarget` in `shell.ts`). Switch sets it; the card's Test (`probe` in `api.ts`, the
  badge's check) also feeds the badge. Add gateway and Pair open as a modal
  (`shared/Dialog.tsx`, native `<dialog>`). A card's link opens `/gateways/<id>`
  (`GatewayDetail.tsx`: Rename/Remove in the title row's ⋮ menu, the update banner, Pair this
  browser, and the collapsed Status / Health / Paired clients tiles; no Open, no Use as
  screen: that is TV mode's top bar), off TV mode's allowlist.
- Per-device **TV mode** (`shared/settings.ts`, `html.tv`); the user agent sets only its
  first-visit default (`features/tv/tv.ts`: known TV → on, Android box → ask once, #309). Its routes
  are an allowlist (`features/tv/tvRoute.ts`): any other route, unknown ones included, renders the
  handoff page (the URL to open on a phone or PC) and drops out of the nav. D-pad = arrow keys:
  `onKeyDown={arrowFocus}` (`frontend/src/shared/focus.ts`) on a container.
- Library home (`features/library/Home.tsx`): Continue watching (desktop/TV: the Resume spot;
  a phone: a row of cards), Recently added, Library, each a row that scrolls sideways.
  Artwork through `art.ts`: loads only on screen, cached per gateway in the Cache API,
  deleted on sign-out and household switch.
- Settings (`features/settings/`): `/settings` is a list of categories; one with more than
  2 settings is its own page (`/settings/playback`, row ends in ›), a smaller one expands in
  place (`<details>`, ⌄, closed on load).

## Hosting and operations

- The root `Dockerfile` builds the SPA and the Go API into one distroless image, run as
  non-root (`/web`, same origin, no CORS in prod). Railway Root Directory = repo root.
- Postgres is a blue/green pair on Railway (`DB_LIVE` names the live one): daily `pg_dump`
  of the live one → GCS (`db-backup.yml`), restores into the idle one (`db-restore.yml`,
  weekly as the drill); runbook `docs/db-recovery.md`.

## Feasibility record

The POC (2026-07-08) proved cellular→home connectivity (86% direct, cellular 100%), TURN
fallback, 1080p + subtitles, seek, HEVC transcode and remux over the tunnel, and 4K via
ABR.
