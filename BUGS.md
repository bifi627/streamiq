# Known Bugs

Behavioral defects and config landmines. Fixed items are deleted (git holds the
history). Design smells → `TECH_DEBT.md`, unbuilt wants → `IDEAS.md`. No
numbers — reference items by heading.

### Firebase emulator data follows the last worktree
**Area:** dev env / docker-compose.yml · **Severity:** Low (dev-only)

`name: streamiq` makes every checkout/worktree drive the same `streamiq-firebase-1`,
but its data is a relative bind mount (`./dev/firebase:/app`). `docker compose up`
from another worktree recreates the container on *that* folder: it starts empty
(accounts look wiped; the old export stays in the previous checkout) and breaks if
that worktree is removed.

**Fix:** named volume for `/app/data` (like `streamiq_pgdata`), keep `./dev/firebase`
as build context; one-time copy of the existing export into the volume.

