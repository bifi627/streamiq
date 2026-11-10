---
name: preview
description: >-
  Use when starting, stopping, restarting or checking StreamIQ's per-worktree
  preview env (`e2e/preview.ts`) so the owner can try this checkout on a phone,
  TV or another device — "start the preview", "let me test on my phone / TV",
  "give me a URL", "stop / tear down the preview", or before handing back device
  work. Covers the LAN (self-signed) mode and `--tunnel` (Cloudflare quick tunnel,
  needed for the webOS TV). Not for the E2E test run (`npm test --prefix e2e`).
disable-model-invocation: true
---

User-invoked only (`/preview [tv] [media] | stop | status`). Arguments: `$ARGUMENTS`
— none = start in LAN mode; `tv` = `--tunnel`; `media` = `--media`; `stop` /
`status` = those sections below.

# Preview env: start / stop

One preview per worktree, owned by a detached process; `preview.ts` holds all
the logic. This skill only fixes **how** an agent drives it, so every run looks
the same. Background: `docs/tools.md` (Preview env + cloudflared rows).

## Rules

- Always from the worktree root, always `npm run preview --prefix e2e -- <cmd>`.
- **Foreground Bash with `timeout: 600000`.** `up` returns on its own once ready
  (2–4 min, first run longer). Never `run_in_background`, never `&`, no sleep
  loops: the stack is already detached.
- **Mode:** a TV is mentioned (or any device whose browser fails every request
  after accepting the cert warning) → `--tunnel`. Otherwise plain `up`. Add
  `--media` only when the owner asks for their `dev-media/` library.
- Don't kill processes by name (`taskkill /IM cloudflared.exe` etc.): T3 Code runs
  its own `cloudflared`. Only `down` stops the preview (it kills the pids it
  recorded).

## Start

1. `npm run preview --prefix e2e -- status`
   - `not running` → step 2.
   - `starting (pid …)` → another `up` is mid-start: run `up` (same flags), it
     waits for that run instead of starting a second one.
   - Running and the mode fits (needs a tunnel → a `tunnel:` line is printed) →
     reuse it, go to step 3.
   - Running in the wrong mode, or the checkout changed in a way Vite can't
     hot-reload (backend, gateway, `e2e/`) → `down`, then step 2.
2. `npm run preview --prefix e2e -- up [--tunnel] [--media]`
   - Exit ≠ 0: `up` already printed the log tail and ran `down`. Read
     `e2e/.preview/logs/<service>.log` for the failing piece, report it with the
     error lines. Don't retry blindly; one retry only for a transient cause
     (network / Docker hiccup) you name.
3. Hand back exactly this, values copied from the `up`/`status` output:

   ```
   Preview of <branch> is running.
   - Phone / desktop: <first LAN URL> (accept the certificate warning once)
   - TV: <first LAN URL>/tv → redirects to <tunnel URL>     ← only with --tunnel
   - Login: preview@streamiq.test / preview-password
   - Pairing: approve on the gateway page <gateway page URL> (this machine)
   - Public while running: anyone with the tunnel URL can reach it  ← only with --tunnel
   - Stop: tell me, or `npm run preview --prefix e2e -- down`
   ```

   First LAN URL = the first address on the `LAN:` line (the real adapter;
   later ones are WSL/Docker). Device can't connect at all → first-time Windows
   Firewall rule from `docs/tools.md`, which the owner runs (admin).

## Stop

1. `npm run preview --prefix e2e -- down` (foreground). It waits until its ports
   are closed and pids gone; `still running after down` = report it, don't
   force-kill by name.
2. `npm run preview --prefix e2e -- status` must print `not running`.
3. Tell the owner it's stopped (and with `--tunnel`: the public URL is gone).

Stop when the owner says so, when the thread's device testing is done, and
before ending work in a worktree that will be pruned
(`scripts/prune-worktrees.ps1` also runs `down`). Leaving it running for the
owner is fine: say so explicitly in the handback.
