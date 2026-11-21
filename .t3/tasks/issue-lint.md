---
# Mirror of the T3 scheduled task "Weekly issue hygiene (issue-lint)" (#527).
# Documentation only: T3 enforces these settings. Change one in T3 → update this header
# in the same PR.
trigger: fixed time, Mondays 09:00 (no webhook, no payload)
freshSession: false
prompt: |
  Weekly StreamIQ issue hygiene check: `git fetch -q origin`, read `.t3/tasks/issue-lint.md` with `MSYS_NO_PATHCONV=1 git show origin/main:.t3/tasks/issue-lint.md` and follow it.
---

Report only: change no issue, label, board card or file.

1. Run the script from `origin/main` without checking it out: `git show origin/main:scripts/issue-lint.sh | bash`.
2. Exit 0 → reply with one line: "issue-lint: clean".
3. Exit 1 → list the findings grouped by rule, each issue as a markdown link (`[#N](https://github.com/bifi627/streamiq/issues/N)`), with the fix you propose for each (label to add, board column, or "refine via refine-issue"). The owner applies them, or asks you in this thread.
4. Exit 2 (gh auth, missing `project` scope, more than 100 open issues) → show the error and the fix (`gh auth refresh -s project`).
