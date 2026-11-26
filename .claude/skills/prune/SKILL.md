---
name: prune
description: >-
  Use when the owner asks to prune / clean up after merges: worktrees and local
  branches already on main, then unused Docker leftovers machine-wide
  (`scripts/prune.ps1`). "/prune", "/prune dry", "clean up worktrees", "free
  Docker space".
disable-model-invocation: true
---

User-invoked only (`/prune [dry]`). `$ARGUMENTS`: `dry` = `-DryRun` (lists, removes
nothing); none = prune.

Run it from this checkout, in the foreground (it skips the checkout it runs in):

```bash
powershell -NoProfile -File scripts/prune.ps1 [-DryRun]
```

Report in a few lines: branches pruned / skipped with reasons (dirty or unmerged
ones are the owner's call, never force them), the `docker system df` before → after
(the space freed tells the owner when compacting `docker_data.vhdx` is worth it), and
every `keep` line for a managed Jellyfin with its stop command. Remove nothing the
script skipped.
