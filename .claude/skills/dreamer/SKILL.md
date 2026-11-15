---
name: dreamer
description: Use when auditing, pruning, or cleaning up the agent's own file-based memory store (the memory/ directory and its MEMORY.md index) — memories gone stale after the project moved on, index and files drifted apart, dangling wiki-links. Also sweeps the project skills (.claude/skills) for repo-state claims that have drifted. Triggered by "review your memory", "clean up the memories", or /dreamer.
---

# Dreamer — memory cleanup

Sessions add memories as they go; nothing removes them. This skill does the removing.

**Core principle: a memory's age is not evidence. The repo is.** Re-derive every claim
from git / code / `CLAUDE.md` / `gh issue list`, never from the memory's own text.

## Passes

Let `MEM` = `~/.claude/projects/<project-slug>/memory/` (slug = the main checkout's path
with every non-alphanumeric character as `-`, e.g. `C--Repositories-streamiq`).

1. **Staleness.** For each memory, check it against the repo:
   - DELETE what the code contradicts, and status/tracking that shipped.
   - DELETE what the repo now says itself (`CLAUDE.md`, a skill, an issue): the repo copy wins.
   - `reference` whose cited file/symbol is gone: keep the lesson if it's durable, fix the citation; else delete.
   - KEEP accurate `feedback` / `user` preferences, however old.
   - Same sweep over `.claude/skills/*/SKILL.md`: fix drifted repo-state claims in place,
     preferring a durable rule or a runtime lookup over a refreshed snapshot.
2. **Index + ids.** One `MEMORY.md` line per file, no line without a file (a delete or add is
   two edits). `name:` = filename without `.md`, kebab-case. `[[x]]` only links memory → memory;
   skills/files go in backticks.
3. **Verify by scanning, not by reasoning.** Run the block; clean = equal counts, empty lists.

```bash
export LC_ALL=C.UTF-8   # without it grep -P errors in Git Bash and the checks pass empty
cd "$MEM"
idx=$(grep -oP '\]\(\K[^)]+\.md' MEMORY.md | sort -u)
fil=$(ls -1 *.md | grep -v '^MEMORY.md$' | sort -u)
echo "index: $(grep -c '^- \[' MEMORY.md)  files: $(echo "$fil" | wc -l)"
echo "in index, no file:";  comm -23 <(echo "$idx") <(echo "$fil")
echo "file, not in index:"; comm -13 <(echo "$idx") <(echo "$fil")
for f in $fil; do n=$(grep -m1 '^name:' "$f" | sed 's/^name:[[:space:]]*//' | tr -d "\"' \r"); \
  [ "$n" != "${f%.md}" ] && echo "NAME OFF: $f ($n)"; done
for x in $(grep -rhoP '\[\[\K[^\]]+' *.md | sort -u); do [ -f "$x.md" ] || echo "DANGLING: [[$x]]"; done
```
