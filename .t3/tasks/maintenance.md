# Mirror of the T3 scheduled task "Weekly maintenance sweep" (#981).
# Documentation only: T3 enforces these settings. Change one in T3 → update this header
# in the same PR.
trigger: fixed time, Mondays 09:30 (no webhook, no payload)
freshSession: true
prompt: |
  Weekly StreamIQ maintenance sweep: `git fetch -q origin`, read `.t3/tasks/maintenance.md` with `MSYS_NO_PATHCONV=1 git show origin/main:.t3/tasks/maintenance.md` and follow it.
---

Report only: change no code, file, issue, label or board card. Uses the owner's `gh` login.

1. **CI times and flakes:** `MSYS_NO_PATHCONV=1 git show origin/main:scripts/ci-drift.sh | bash`
   (several minutes: one API call per run, plus the failed logs of rerun attempts). It prints
   the median per required build job (`e2e` = the slowest shard) over the last 50 successful
   `main` runs of this week vs the week before, flagging `SLOWER >20%`, and every test that
   failed and then passed on a rerun, flagging `SEEN Nx` for a test seen more than once.
   A `n/a` change is a job that didn't run or had another name last week: say so, no finding.
2. **Dependencies:** run the outdated commands of `deps-bump`'s "Derive the work" section
   read-only (read it with `MSYS_NO_PATHCONV=1 git show origin/main:.claude/skills/deps-bump/SKILL.md`):
   `npm outdated` in `frontend/` and `e2e/`, Go direct modules only
   (`go list -m -u -f '{{if and (not .Indirect) .Update}}{{.Path}} {{.Version}} -> {{.Update.Version}}{{end}}' all`), the open Dependabot alerts query, and the pins
   in `docker-compose.yml`, `.devcontainer/devcontainer.json` and `.github/workflows/*.yml`
   against their latest releases. Install nothing, change no lockfile.
   Group by patch / minor / major; Dependabot alerts first, with their patched version.
3. **Report** in this thread, one section per area:
   - Nothing flagged in an area → one line ("CI times: nothing > 20 % slower").
   - Each finding (a `SLOWER` job, a `SEEN` test, a major, the patch + minor batch as one)
     → first search for a duplicate
     (`gh -R bifi627/streamiq issue list --state all --search "<words>"`): one exists → link
     it, with whether this week adds anything. Else propose an issue: title, labels
     (CLAUDE.md "Tracking"), body in the `.github/ISSUE_TEMPLATE/task.md` structure. A flaky
     test's body names the runs the script printed.
   - Create nothing: the owner approves each proposal in this thread, then you create it.
   - Every issue number as a markdown link (`[#N](https://github.com/bifi627/streamiq/issues/N)`).
4. An open Dependabot alert (or any other security-relevant finding) is reported in this
   thread only, never as an issue (public repo; CLAUDE.md): propose a `deps-bump` run for it.
