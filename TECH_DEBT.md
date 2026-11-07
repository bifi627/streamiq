# Tech Debt

Deferred hardening, test-harness robustness, and design smells accepted on
purpose. Defects → `BUGS.md`, unbuilt wants → `IDEAS.md`. Clear an item by
fixing it and deleting its section (git holds the history). No numbers —
reference items by heading.

### Token minter masks real HTTP failures
**Area:** tests / TokenMinter.cs

Emulator error-body parsing assumes an `error` JSON shape; a real HTTP failure
(5xx, non-JSON) could be masked. Guard with `TryGetProperty` / `EnsureSuccessStatusCode()`.

**Pay down:** next time the token minter is touched, or if a test fails with a confusing parse error.

### Broker registry is in-memory
**Area:** control-plane / Features/Broker

Broker registry is in-memory: correct only with a single API instance (Railway today).
The signaling rate limits (per-IP sockets/enrollments) are in-memory per instance
too: N instances = N× the budget. Per-socket message limits are unaffected.

**Pay down:** second API instance → Postgres LISTEN/NOTIFY or Redis (move the per-IP
counters to the same store, or to the edge: IDEAS.md "Cloudflare proxy in front of the API").

### Gateway cert has no rotation
**Area:** gateway / cert rotation

Gateway DTLS cert is 10 years with no rotation (spec non-goal: rotation =
re-onboard + re-pair). A once-a-decade manual step will be forgotten, and Pion
refuses an expired cert → gateway down at expiry. Plan (SSH UpdateHostKeys-style):
~1-year cert; ~60 days before expiry the gateway pre-generates the next cert
(state dir) and sends `{type:"next-pin", fp}` on the `auth` channel *after* the
old pin verified; browser stores it as a second pin; gateway switches at expiry;
reports the new fp to the server (display only). Browsers unused for the whole
window re-pair (= today). ~40 lines Go + ~15 TS + protocol.md message + Go/TS
test. Keep 10 years until this exists.

**Pay down:** item 4 (productized gateway, alongside auto-update).

### Local page shows Jellyfin admin password unauthenticated
**Area:** gateway / localpage

The gateway's LAN page (`:8097`) shows the bootstrapped Jellyfin admin
password to anyone on the home LAN (only the Host/Origin guard; no login).
Fine for a single household's LAN; not fine on shared/guest networks.
Plan: gate the page (or just the secrets) behind a Firebase sign-in of a
tenant member, verified by the gateway against the API.

**Pay down:** before strangers install (item 6 / Checkpoint 3), or when the
local page grows admin actions (IDEAS.md "Media management").

### npm audit: frontend grpc-js (via firebase)
**Area:** frontend / npm audit

4 high `@grpc/grpc-js` advisories (GHSA-m9gg-hp2v-232j, GHSA-f596-whhp-79r4;
fixed in ≥1.13.6). Transitive via `firebase` → `@firebase/firestore`, which pins
`~1.9.0` even at latest (firebase 13.1.0 / firestore 4.19.0). Not exploitable
here: both are gRPC-*server* issues, we never import Firestore, and the built
bundle contains no grpc code. No `overrides` forced into a module we don't load;
`npm audit fix --force` would downgrade to firebase 9.

**Pay down:** when a firebase release moves firestore off grpc-js 1.9 (check at each deps sweep), or immediately if we start using Firestore.

### npm audit: e2e glob/minimatch (via testcontainers)
**Area:** e2e / npm audit

7 moderate entries = 2 advisories: glob GHSA-3g3m-2fjr-6pw4 (AbortSignal timeout
bypass) and minimatch GHSA-g3hv-75wg-m249 (pattern DoS), via `testcontainers` →
`archiver@7` → `archiver-utils` (glob 10) / `readdir-glob` (minimatch 5). Not
reachable: test-only, and archiver only tars our own `firebase.json`
(testcontainers never calls `glob()`; patterns are ours, no untrusted input).
Fixes (glob 14.0.2 / minimatch 11.0.1, both still CJS with the same `sync` /
`Minimatch` exports) shipped 2026-10-27/28 — too young for `min-release-age=7`.
`audit fix --force` would downgrade testcontainers to 10.x; archiver 8 is
ESM-only, so it can't be overridden in.

**Pay down:** from 2026-11-04: add `"overrides": { "glob": "^14.0.2", "minimatch": "^11.0.1" }` to `e2e/package.json`, `npm install`, confirm `npm audit` is clean + e2e green. Or drop it if testcontainers moves to archiver 8 first.

### No Postgres backup/restore story
**Area:** control-plane / Railway Postgres

The implementation plan's item 6 includes a backup/restore story for Postgres;
deferred out of the item 6 hardening PR. Today it's whatever Railway does by default,
and no restore has ever been tested. What's at stake is tenants, users, gateway
credential hashes + pins, and connection telemetry; media never touches the DB.

**Pay down:** before strangers install (Checkpoint 3): document Railway's
backup/restore, and run one restore into the dev instance end to end.

### Client error handling is quiet and vague
**Area:** frontend / errors

Failures reach the user as vague text or not at all. Known cases:
- **Rate-limited broker socket:** a `429` on the WebSocket upgrade is invisible to
  browser JS (the WebSocket API exposes no HTTP status), so the user sees only
  "broker connection closed". Plan: a socket that closes *before* `onopen` gets a
  loud, specific message ("Couldn't reach StreamIQ: too many attempts or offline.
  Try again in a minute."), distinct from a drop mid-session.
- **Authed shell swallows API errors:** see BUGS.md.

Plan: one visible error banner/toast pattern for the app, with each failure
mapped to a specific, actionable message.

**Pay down:** before the limited beta (Checkpoint 3), or when the UI gets its first
real design pass.
