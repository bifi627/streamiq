# Ideas

Wanted but not yet built, and neither a defect (`BUGS.md`) nor debt
(`TECH_DEBT.md`). Promote to a task when picked up; delete when done or
dropped. No numbers — reference items by heading.

### Phone as a local dev client (LAN + HTTPS)
**Area:** dev env

Local dev only works from the PC itself: Vite + backend bind `localhost`, the
page hardcodes `http://localhost:5028` (API) and `:9099` (auth emulator), and
plain `http://<pc-ip>` is not a secure context → no `crypto.subtle` → no client
key → a phone can't pair. Owner wants the phone as second local client. Plan:
Vite `--host` + self-signed HTTPS (`@vitejs/plugin-basic-ssl`, new dev dep —
justify), backend on `0.0.0.0` with HTTPS (or proxied through Vite so the phone
needs one cert), API/emulator URLs derived from `location.hostname`, `dev.ps1`
switch (e.g. `-Lan`). Phone clicks through one cert warning. Gateway page
(`http://<pc-ip>:8097`) stays plain HTTP — needs no WebCrypto. Interim: test
phones against the Railway dev deployment (HTTPS).

**When:** before the iOS device test / item 5 streaming client, whichever comes first.

### Media management (library folders, rescan)
**Area:** gateway / Jellyfin admin

Item 5 is consumption-only (browse, play, seek, resume). Nothing in the plan
owns Jellyfin setup (admin user, API key, library folders) or upkeep (add a
folder, rescan, fix metadata) — implicitly item 4's job, which is deferred.
Today: owner sets Jellyfin up once by hand in its own dashboard
(`http://localhost:8096`; dev: `scripts/setup-jellyfin.sh`). Plan: small admin section on the LAN-only gateway
page (`:8097`) that drives Jellyfin's API — folder picker + rescan; stays
local, so nothing sensitive crosses the control plane. Not in the StreamIQ web app
(remote admin = new attack surface).

**When:** with item 4 (productized gateway), or once a non-owner household installs.

### Nightly channel
**Area:** gateway / release

Prerelease builds for the owner's second installed copy. Gateways update from
GitHub Releases (item 4); `releases/latest` skips prereleases, so nightly =
CI publishes `gateway-vX.Y.Z-nightly.<n>` as a prerelease and a nightly
install follows prereleases instead of latest (one flag on the update check
and install script). On the dev machine: another install dir with its own
state, page port and Jellyfin. Detail: item 4 spec.

**When:** once there are real users on stable worth protecting from untested builds.

### In-app setup guide
**Area:** frontend / gateways

The full home setup (Jellyfin → gateway → connect Jellyfin → libraries → pair)
lives only in `docs/install.md`. The Add gateway dialog could walk through it
instead: Jellyfin options with the compose download link, the install command,
then live status from the gateway's heartbeat (online, Jellyfin reachable, key
set) until the first browser is paired. Needs the heartbeat to carry the
Jellyfin status (today it's only on the local page).

**When:** before non-owner households install (with auto-update + signing).

### Non-admin Jellyfin credential for the gateway
**Area:** gateway / security

The gateway holds a Jellyfin API key, and API keys are always admin, so the
tunnel allowlist (`gateway/internal/tunnel/jellyfin.go`) is the *only* thing
between a paired browser and full Jellyfin admin. Plan: during setup
(`gateway/internal/jellyfin`, `bootstrap` / `Login`), use the admin sign-in
once to create a dedicated non-admin `streamiq` user (`POST /Users/New`, policy:
not admin, no deletion, no remote control, optionally limited libraries), then
sign in as it and keep that session's `AccessToken` (no logout) instead of
minting an API key. Store token + password in `state/jellyfin.json` so the
gateway can sign in again if the token is revoked (it shows up as a device in
the dashboard). Upgrade path for existing installs: on the next admin login,
switch to the new token and delete the old `streamiq-gateway` key. Bonus: the token implies the
user, so the `/Users` lookup that pins the user mostly goes away, and one token per
Jellyfin user is the path to per-member profiles. The allowlist stays: the user can
still change its own settings, create playlists, and see its own sessions.
Verify on 12.4: password change vs token lifetime; what to do with the
`STREAMIQ_JELLYFIN_API_KEY` override (still admin).

**When:** item 6 (hardening).

### User metadata on the gateway
**Area:** gateway / client

Things users add that Jellyfin can't store: custom tags, marked segments ("special
moments" on the seek bar), notes, lists. Prefer Jellyfin's own features first
(favorites `POST /UserFavoriteItems/{id}`, rating/likes in `UserData`: one
allowlist line + UI each). Decided (2026-11-07): the rest lives on the **gateway**,
not the control plane. Nothing leaves home and no crypto is needed, and while the
gateway is offline the library can't be browsed anyway, so the control plane's
availability buys nothing. The control plane option needed HMAC'd item IDs +
browser-side encrypted text + key distribution. Plan: `metadata.json` in the state
dir (JSON with a `version` field; additive changes need no migration; write via
temp file + rename), served by the gateway itself under a `/streamiq/*` prefix in
the tunnel (not forwarded to Jellyfin). Key records by a stable ID (provider ID
such as TMDB/IMDb, else file path), not the Jellyfin item ID, so the data survives
a reinstall or a media-server switch. Move to SQLite (`modernc.org/sqlite`, pure
Go; `mattn` needs cgo and breaks cross-compiled releases) only when it outgrows
JSON. Version skew: the web app is always newer than a user-updated gateway, so
the browser checks the gateway version (already in the heartbeat) per feature and
says "update your gateway". Profiles caveat: until there are per-member Jellyfin
users (see "Non-admin Jellyfin credential for the gateway"), metadata is shared by
the whole household.

**When:** first feature Jellyfin can't do (likely custom segments).

### Gateway backup / restore
**Area:** gateway

A single file the user can keep: "Download backup" on the local page (`:8097`)
zips the state dir (stdlib `archive/zip`); "Restore" unpacks it. Storage stays a
folder; only the backup is one file. Contents: identity cert + key, pairing
allowlist, Jellyfin credentials, user metadata. So it **is a secret**: encrypt
with a passphrase or warn loudly. Restore keeps the gateway identity, so paired
clients stay paired after a failed install or a new machine. It also clones the
gateway: decide what happens if the old one still runs (API rejects duplicates,
or the last one to connect wins). Not included: Jellyfin's own `config` volume
(library, watch history). Say so, or add it as a follow-up. Needs user docs:
new section in `docs/install.md` (what's in the backup, keep it safe, how to
restore after a reinstall / to a new machine, what's not covered), plus a short
hint on the local page.

**When:** before non-owner households install, or with "User metadata on the gateway".

### Encrypted off-site backup
**Area:** gateway / control plane

Disk-loss protection without the user managing storage: the gateway encrypts
the backup (from "Gateway backup / restore") with a household key and uploads it
to the control plane as one opaque blob. The control plane learns nothing, not
even per-item counts, which is stronger than per-row encryption. Key loss = the
backup is unreadable: show a recovery code on the local page once. User docs:
what we store (an encrypted blob), what we can't read, and that the recovery
code is the only way back.

**When:** after local backup/restore exists and users actually lose data.

### Cloudflare proxy in front of the API
**Area:** hosting / edge security

Research what proxying the app's domain through Cloudflare (orange-cloud DNS in
front of Railway) would buy: DDoS absorption, WAF rate-limiting rules as a flood
shield on `/gateways/enroll` + the WebSocket upgrade paths (free plan: 1 rule,
counted per IP, 10 s window/block; Pro: 2 rules, up to 1 min / 1 h), bot rules.
It complements the in-app limits (item 6) and can't replace them: it can't see
messages inside a WebSocket, and it can't count per user. Switching means the
client-IP header changes from Railway's `X-Real-IP` to `CF-Connecting-IP`.

**When:** before the limited beta signup (Checkpoint 3), or at the first real flood.
