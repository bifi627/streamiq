# Known Bugs

Behavioral defects and config landmines. Fixed items are deleted (git holds the
history). Design smells → `TECH_DEBT.md`, unbuilt wants → `IDEAS.md`. No
numbers — reference items by heading.

### Prod login fails if FIREBASE_PROJECT_ID is unset
**Area:** control-plane / deploy · **Severity:** High (prod-only)

`FIREBASE_PROJECT_ID` defaults to `demo-streamiq`; if unset in prod, real token
verification fails for every login. Fails closed (no logins), not open.

**Fix:** set `FIREBASE_PROJECT_ID` in the Railway prod env; consider failing startup fast if it's still `demo-streamiq` outside dev.

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
