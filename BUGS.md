# Known Bugs

Behavioral defects and config landmines. Fixed items are deleted (git holds the
history). Design smells → `TECH_DEBT.md`, unbuilt wants → `IDEAS.md`. No
numbers — reference items by heading.

### Removed browser keeps its open sessions
**Area:** control-plane / Features/Broker · **Severity:** Medium (security)

A paired browser removed on the gateway page keeps its *open* sessions until they
disconnect (its next connect is refused).

**Fix:** removal kills live sessions, with item 6 hardening.

### Authed shell swallows API errors
**Area:** frontend / App.tsx · **Severity:** Low (UX)

The authed shell `.catch(() => {})`-swallows `getMe()`/`getGateways()` errors — a
failed call shows an empty shell with no signal.

**Fix:** surface the error in the UI once the shell grows real content (item 5).

### Provisioning DB failure surfaces as 500
**Area:** control-plane / UserProvisioner · **Severity:** Low

A non-race `DbUpdateException` during first-sign-in provisioning surfaces as
HTTP 500, not 401. Accepted for now (the race path is handled; this is the
genuinely-broken-DB path).

**Fix:** leave as-is; revisit if it masks a real auth failure.

### Dev gateway.env lacks STREAMIQ_API_URL
**Area:** dev tooling / `scripts/setup-jellyfin.sh` · **Severity:** Low (dev-only)

`setup-jellyfin.sh` writes `gateway/gateway.env` with origin, page port and API
key but no `STREAMIQ_API_URL`, so `go run ./cmd/gateway` exits with
"STREAMIQ_API_URL not set" unless the web app's Add gateway command (or the
shell) supplies it.

**Fix:** also write `STREAMIQ_API_URL=http://localhost:5028` (the dev backend).
