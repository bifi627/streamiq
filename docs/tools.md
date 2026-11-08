# Tools & credentials inventory

The external tools and services StreamIQ depends on (not code libraries), why each
one exists, and every credential they need. Use this for key-rotation drills.
Version pins live in `docker-compose.yml`; bump them with the `deps-bump` skill.

## Tools

| Tool | What it is | Problem it solves in StreamIQ | Dev | Prod |
|---|---|---|---|---|
| **Jellyfin** | Open-source media server | Media engine on the user's hardware: library scan, serving, transcoding codecs the browser can't play (HEVC/AC3). The gateway tunnels its HTTP over WebRTC, so we never write a transcoder. **Pinned image, never `latest`.** | compose (`jellyfin/jellyfin:12.4.20261026-211555`, host port 18096) | User's NAS/PC: their own install, or the release asset `jellyfin-compose.yml` (same pin; `jellyfin.Tested` in the gateway must match) |
| **Pion** (Go gateway) | WebRTC stack in Go | Gateway side of the tunnel. *(A library, listed because it's the core tunnel engine.)* | native `go run` | User's NAS/PC |
| **GitHub Releases** | Binary distribution | Gateway binaries (windows/linux/darwin × amd64/arm64) + `SHA256SUMS` + `install.sh` / `install.ps1`, published by `.github/workflows/release-gateway.yml` on a `gateway-v*` tag. The gateway checks `releases/latest` (unauthenticated GitHub API, 60 req/h/IP; it calls once a day) and logs the update command. Notify-only: nothing self-updates. | — | yes (public) |
| **distroless/static** | Minimal container base | `gateway/Dockerfile`: optional Linux-Docker runtime + `E2E_GATEWAY_IMAGE` e2e mode. Not the supported runtime (Docker Desktop's NAT forces relay on cellular). | e2e opt-in | — |
| **STUN** (Google) | Public address discovery | Lets peers learn their public IP:port for direct hole-punching (86% of POC sessions). Hardcoded `stun:stun.l.google.com:19302` in the gateway. | same | same |
| **coturn** | Open-source TURN server | Local relay so the TURN fallback path can be forced and tested at a desk (`?relay` → `iceTransportPolicy: 'relay'`). The e2e starts its own on a random port block per run (20000–40000), so concurrent worktrees do not collide. | compose `--profile relay`; e2e container | — |
| **Cloudflare Realtime TURN** | Hosted TURN relay | Relays traffic when direct WebRTC fails (strict NAT / guest Wi-Fi, ~14% in POC). Needed because Railway has no UDP ingress. $0.05/GB outbound. | — (coturn instead) | yes |
| **Postgres** | Relational DB | Control-plane data: tenants, users, gateways, connection telemetry. | compose `postgres:18` | Railway Postgres |
| **Google Cloud Storage** | Object storage | Off-site Postgres backups: `db-backup.yml` uploads a daily `pg_dump` to bucket `streamiq-db-backup` (us-central1, in the Firebase GCP project; 30-day lifecycle delete). Runbook: `docs/db-recovery.md`. | — | yes |
| **Firebase Auth** | Hosted identity | Sign-in (email/password + Google, #66) + ID tokens the backend verifies. Auth only (no Firebase storage). | Auth emulator container (`demo-streamiq`) | Firebase project |
| **Railway** | PaaS hosting | Runs the backend (API + signaling WS + the built SPA, same origin) and Postgres. Service Root Directory = repo root; it builds the root `Dockerfile`. | — | yes |
| **ffmpeg** | Video toolkit | `scripts/gen-test-media.sh` generates the codec test fixtures. | dev machine | — |
| **Docker / Testcontainers** | Containers + test-driven container lifecycle | Runs compose deps; integration tests use real Postgres / Firebase emulator / Jellyfin instead of mocks. | yes | CI |
| **Playwright** + Google Chrome | Browser automation | The one E2E golden path (`e2e/`): real browser → broker → gateway → Jellyfin. Branded Chrome, not bundled Chromium — item 5's `<video>` needs H.264/AAC. Stack comes up via testcontainers-node (random ports). | `npm test --prefix e2e` | CI `e2e` job |
| **GitHub Actions** | CI + releases | Runs `scripts/check.sh`-equivalent jobs; `release-gateway` publishes gateway releases with the built-in `GITHUB_TOKEN` (`contents: write`, that job only). `db-backup` (daily) dumps prod Postgres to GCS, using the backup secrets below. | — | CI |
| *Cloudflare R2* | Object storage | **Deferred (QOL)**: cloud files, picked over GCS for zero egress. Not wired yet. | — | — |

## Credentials

Dev credentials are fixed, throwaway values with no rotation needed. Every prod
credential is set by a human at deploy time. None are in the repo.

Where to request or rotate credentials by hand:

- **Firebase service account key:** [Firebase console → Project settings → Service accounts](https://console.firebase.google.com/project/_/settings/serviceaccounts/adminsdk) (generate), [GCP → IAM → Service accounts](https://console.cloud.google.com/iam-admin/serviceaccounts) (list/delete keys)
- **Firebase web API key restrictions:** [GCP → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
- **Cloudflare TURN key + API token:** [Cloudflare dashboard](https://dash.cloudflare.com/) → Realtime → TURN Server ([docs](https://developers.cloudflare.com/realtime/turn/))
- **Railway env vars + Postgres:** [Railway dashboard](https://railway.com/dashboard) → project → service → Variables

| Credential | Belongs to | Used by | Where it lives | Lifetime | How to rotate |
|---|---|---|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase / GCP service account | Backend (FirebaseAdmin init). Prod fails fast if empty. | Railway env var | Until revoked | GCP console → IAM → Service accounts → Keys: create a new key, paste the JSON into Railway, redeploy, check sign-in works, **then** delete the old key. |
| `FIREBASE_PROJECT_ID` | Firebase | Backend | Railway env var | not a secret | Only changes if the project changes. Required: the API refuses to start if it's unset, or if it's a `demo-*` project with no emulator host set. |
| `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID` | Firebase web app | Frontend bundle | Railway variables on the backend service, passed into the root `Dockerfile` as build args (build fails if any of the three is missing) | not a secret (public by design) | Restrict the key to allowed domains in GCP; the app's domain must be in Firebase Auth → authorized domains. A rotated key needs a redeploy (rebuild). |
| **Google sign-in provider** (OAuth client + consent screen) | Firebase project (GCP), owned by the project owner. Set up by hand in the console, not by CI. | Frontend "Continue with Google" (`signInWithPopup`). Dev/E2E use the Auth emulator's fake Google popup: no real Google project. | Firebase console → Authentication → Sign-in method → Google (enabled; Firebase creates the web OAuth client). Consent screen: [GCP → Google Auth Platform → Branding](https://console.cloud.google.com/auth/branding) (app name "StreamIQ", support email). Domains: Firebase → Authentication → Settings → **Authorized domains** (the app's domain must be listed or the popup fails with `auth/unauthorized-domain`). | not a secret (client ID is public; Firebase holds the client secret) | Nothing to rotate. Change the app name or support email on the Branding page; add a domain to Authorized domains before serving the app from it. Keep "one account per email address" (the default): a password user who later picks Google keeps the same UID, so the same tenant. |
| `CORS_ORIGINS` | StreamIQ backend config | Backend CORS allowlist: comma-separated SPA origins (scheme + host + port, no trailing slash, no path), e.g. `https://app.example.com,https://streamiq-web.up.railway.app`. Unset = `http://localhost:5173` (vite dev). Not needed for the Railway SPA: it is served same-origin by the backend. | Railway env var | not a secret | Only for an SPA hosted on another origin; update when that domain changes, then redeploy. If it's wrong, the SPA fails with a CORS error in the browser console. |
| `STREAMIQ_PUBLIC_URL` (optional) | StreamIQ backend config | URL put into the gateway install command (`STREAMIQ_API_URL=…`). Unset = the URL the request came in on; the image sets `ASPNETCORE_FORWARDEDHEADERS_ENABLED=true`, so behind Railway that is already `https://`. Set only for a custom domain the proxy does not pass through. | Railway env var | not a secret | Update when the public domain changes, then redeploy. |
| `STREAMIQ_CLIENT_IP_HEADER`, `STREAMIQ_SIGNALING_PER_MINUTE` (optional) | StreamIQ backend config | Signaling rate limit: new `/broker/ws` + `/gateways/ws` sockets and `/gateways/enroll` calls per client IP per minute (default 120: a flood shield, sized so many users behind one shared IP don't trip it). The client IP comes from the named header; the image sets `X-Real-IP` (Railway's edge). Unset or header missing = `RemoteIpAddress` (in the image: the rightmost `X-Forwarded-For` entry, appended by Railway's proxy; never the client-writable left entries). | Dockerfile `ENV` / Railway env var | not a secret | A Cloudflare proxy in front would need `CF-Connecting-IP` (issue #54). |
| `DB_BACKUP_URL` | Railway Postgres (public TCP proxy URL, `?sslmode=require`) | `db-backup.yml` (pg_dump) | GitHub Environment `production` secret | Until the Postgres password changes | Rotates with the Postgres password: after changing it in Railway, copy the new `DATABASE_PUBLIC_URL` into the secret and run the workflow by hand. |
| `GCS_BACKUP_SA_KEY` (+ repo variable `GCS_BACKUP_BUCKET`, not a secret) | GCP service account `streamiq-db-backup` (only `roles/storage.objectCreator` on the bucket) | `db-backup.yml` (upload) | Repo secret | Until revoked | GCP → IAM → Service accounts → `streamiq-db-backup` → Keys: add a key, paste the JSON into the secret, run the workflow by hand, **then** delete the old key. |
| `DATABASE_URL` (or `ConnectionStrings__Default`) | Railway Postgres | Backend | Railway variable reference | Until changed | Change the Postgres password in Railway. The backend picks up `DATABASE_URL` through the variable reference, so redeploy and check `/me`. |
| **Cloudflare TURN Key ID + API token** (`CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`) | Cloudflare Realtime → TURN | The broker mints one credential per browser session (in `ready`) and revokes it when the session's socket closes. Also `scripts/gen-turn-creds.ps1` (gateway TURN, optional). | Railway env vars on the backend (set by a human at deploy). Unset = dev path (`STREAMIQ_TURN_URLS` + `STREAMIQ_TURN_SECRET`, or STUN only). | Until revoked | Cloudflare dashboard → Realtime → TURN: create a new key/token, set both Railway vars, redeploy, check a `?relay` session, revoke the old one. |
| Minted TURN username/credential | Cloudflare (generated) | Browser (one per broker session, from `ready`); gateway only if `STREAMIQ_ICE_*` is set (`gen-turn-creds.ps1`, 24 h) | Browser memory; gateway env / `dev/.cloudflare-turn.json` (git-ignored) | Browser: the session (revoked at its end; 4 h TTL backstop). **24 h** script | Nothing to rotate. Never bake a static TURN secret into the client. |
| Enrollment token | StreamIQ (per Add-gateway click) | Gateway's first start (`STREAMIQ_ENROLL_TOKEN`) | API: SHA-256 hash in `enrollment_tokens`; plaintext only in the install command (the install scripts never write it to `gateway.env`) | **15 min, single-use** | Nothing to rotate: create a new one in the web app (Add gateway). A spent token left in shell history is harmless. |
| Gateway credential | StreamIQ (per gateway) | Gateway → control plane (Bearer on `/gateways/ws`) | Gateway: `STREAMIQ_STATE_DIR/gateway.json`; API: SHA-256 hash in `gateways.CredentialHash` | Until the gateway is re-onboarded | Re-onboard = rotation: delete the state dir (`dev.ps1 -ResetGateway` in dev), Add gateway, run the new command. Revoke: **Remove** in the web app's Gateways list (`DELETE /gateways/{id}`): the credential stops working and the live socket and its sessions close. To re-add the box, delete `gateway.json` in the state dir and run a new install command; `cert.pem` stays, so browser pins survive. |
| Gateway DTLS certificate | StreamIQ gateway (self-signed, ECDSA P-256) | WebRTC DTLS; browsers pin its fingerprint | Gateway: `STREAMIQ_STATE_DIR/cert.pem`; API: `gateways.DtlsFingerprint` | 10 years | Re-onboard + re-pair every browser, by design (no rotation mechanism). |
| Browser client key | the browser (WebCrypto ECDSA P-256, non-extractable) | Proves a paired browser to the gateway (session-bound signature on the `auth` channel) | Browser: IndexedDB `streamiq`/`kv` `clientKey` (+ gateway pins `pin:<gatewayId>`); gateway: key fingerprint in `STREAMIQ_STATE_DIR/allowlist.json`. Never on the server. | Until site data is cleared | Remove the browser on the gateway page, then Pair this browser again (new key if site data was cleared). |
| Jellyfin viewer token + viewer password | Local Jellyfin (hidden non-admin user `streamiq-viewer`, created by the gateway) | Gateway → Jellyfin: token injected into every tunnelled request, stripped from browser requests, redacted from responses. Browsers never hold it. The viewer password lets the gateway sign in again when the token is revoked. | `state/jellyfin.json` (0600), with the admin password only if the gateway created the admin (wizard bootstrap). Made by the gateway from an admin session it doesn't keep: wizard bootstrap, or one admin login on the local page. Dev: sign in on the dev gateway's page as `streamiq` / `streamiqdev` (`scripts/setup-jellyfin.sh` sets that admin up). E2E: `e2e/stack.ts` signs in on the page per run (admin from `e2e/jellyfin.ts`). | Until revoked (no expiry) | Sign in again on the local page with an admin (**Connect Jellyfin** appears when the token and viewer password stop working; to force it, delete `state/jellyfin.json` and restart). That sets a new viewer password and revokes the old token. Cut the gateway off: delete or disable the user `streamiq-viewer` in Jellyfin (signing out its device only makes the gateway sign in again). Before #50: an admin API key `streamiq-gateway`; the next page login deletes it. |
| Local page token | StreamIQ gateway (random, 256-bit) | LAN browsers → gateway's local page: `?t=` login link sets an HttpOnly SameSite=Strict cookie (1 year). Loopback needs none. Never sent to the API, never logged. | Gateway: `state/page-token` (0600); login link in `state/page-link` (0600), printed by the installer; browser cookie `streamiq_page` | Until rotated | Delete `state/page-token`, restart the gateway (signs out every browser); re-open the new link from `state/page-link`. |
| coturn auth secret `dev` (`--static-auth-secret`, = `STREAMIQ_TURN_SECRET`; e2e's own `e2e`), Postgres `streamiq:dev` | Local compose / e2e | Dev only | `docker-compose.yml`, `.env.example`, `e2e/global-setup.ts` | dev-only | n/a |

## Rotation drill checklist

1. Pick the credential from the table and create the new one **before** revoking the old one.
2. Update it in Railway (or Cloudflare) and redeploy.
3. Exercise the flow it protects: sign-in for Firebase, `/me` for the DB, a forced-relay session for TURN.
4. Revoke the old credential and confirm the flow still works.
5. Write down the date here or in the PR.

## Rename r8er → StreamIQ: steps outside the repo (2026-11-06)

The repo was renamed in one PR. These names live outside git and still say `r8er`
until a human changes them:

- **GitHub repo** `bifi627/r8er` → `bifi627/streamiq`. The installers and the gateway
  update check (`gateway/internal/update`) already point at the new URL; GitHub redirects
  the old one. Do this before the first `gateway-v*` tag.
- **Railway**: the project/service display names. Env var names on Railway are unaffected
  unless one starts with `R8ER_` (e.g. `R8ER_PUBLIC_URL`) → rename it to `STREAMIQ_…`.
- **Local dev DB**: compose is pinned to project `streamiq` (`name:` in docker-compose.yml), so it
  starts on fresh `streamiq_*` volumes with DB/user `streamiq`. The old `r8er_*` volumes are
  orphaned: `docker compose -p r8er down -v` removes them. A user-secrets `ConnectionStrings:Default` pointing at a
  Railway dev DB keeps working (it names the DB explicitly).
- **Local `gateway/gateway.env`** (git-ignored, from `scripts/setup-jellyfin.sh`): keys are
  now `STREAMIQ_*`; re-run the script. Old state dir `gateway/r8er-state/` → `streamiq-state/`
  (move it to keep the dev gateway's identity, or re-enroll).
- **Every paired browser (dev and prod)**: the client key moved to IndexedDB `streamiq` and the auth
  label changed, so each browser re-pairs once; gateways keep stale allowlist entries (harmless).
