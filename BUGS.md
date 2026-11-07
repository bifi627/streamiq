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
