// T3 workflow `group`: builds a parent issue's open sub-issues one at a time, each to a PR, and
// waits for the owner's merge between them. Started by `agent-issue` (or by hand, docs/tools.md).
// T3 loads this file from the main checkout (T3CODE_WORKFLOWS) and injects T3, Effect, Schema, Option.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { buildOrder, fixes, isReady } from "./lib/group-plan.ts";

const { workflow, step, agent, ask, stop, title, pullRequests } = T3;

const repo = "bifi627/streamiq";
const project = resolve(import.meta.dirname, "../..");
const issueUrl = (n) => `https://github.com/${repo}/issues/${n}`;

const gh = (...args) =>
  Effect.try({
    try: () => JSON.parse(execFileSync("gh", args, { encoding: "utf8" })),
    catch: (e) => new Error(String(e)),
  });

const Plan = Schema.Struct({
  title: Schema.String,
  order: Schema.Array(Schema.Number),
  problem: Schema.NullOr(Schema.String),
});

const readPlan = (parent) =>
  Effect.gen(function* () {
    const issue = yield* gh("api", `repos/${repo}/issues/${parent}`);
    const subs = yield* gh("api", `repos/${repo}/issues/${parent}/sub_issues?per_page=100`);
    const open = subs.filter((s) => s.state === "open").map((s) => s.number);
    const order = open.length === 0 ? "all sub-issues are closed" : buildOrder(issue.body ?? "", open);
    return typeof order === "string"
      ? { title: issue.title, order: [], problem: order }
      : { title: issue.title, order, problem: null };
  });

const Sub = Schema.Struct({
  title: Schema.String,
  open: Schema.Boolean,
  ready: Schema.Boolean,
  pr: Schema.NullOr(Schema.String),
});

const readSub = (n) =>
  Effect.gen(function* () {
    const issue = yield* gh("api", `repos/${repo}/issues/${n}`);
    const prs = yield* gh("pr", "list", "-R", repo, "--state", "open", "--search", `${n} in:body`, "--json", "url,body");
    return {
      title: issue.title,
      open: issue.state === "open",
      ready: isReady(
        issue.labels.map((l) => l.name),
        issue.body ?? "",
      ),
      pr: prs.find((p) => fixes(p.body, n))?.url ?? null,
    };
  });

const Built = Schema.Struct({
  pr: Schema.String,
  verdict: Schema.String,
  headSha: Schema.String,
  noticed: Schema.Array(Schema.String),
});

const brief = (n) => `Run the \`build-issue\` skill on #${n} (\`/build-issue ${n}\`) in ${repo}.

A workflow run started you as one sub-issue of a group, in the group's order: for build-issue's
"a still-open sub-issue before it" check you count as started by a group's orchestrator. There is
no orchestrator thread: send no \`t3_thread_send\` report.

Submit your result only when build-issue section 4 is done: \`pr\` = the PR's full URL, \`verdict\` =
its review label (\`review:ready\`, \`review:changes\` or \`review:decision\`), \`headSha\` = the PR's head
commit, \`noticed\` = the lines of its \`## Noticed\` section (empty if none). A turn that ends
while you wait (a question to the owner, CI, the review) submits nothing.`;

const refined = "It is refined, go on";

workflow(
  "group",
  { version: 1, payload: Schema.Struct({ parent: Schema.Number }) },
  Effect.fn(function* ({ parent }) {
    const plan = yield* step("plan", { returns: Plan }, readPlan(parent));
    yield* title(`Group #${parent} ${plan.title}`);
    if (plan.problem !== null) return yield* stop(plan.problem);

    const built = [];
    for (const n of plan.order) {
      let sub = yield* step(`read-${n}/0`, { returns: Sub }, readSub(n));
      for (let i = 1; sub.open && sub.pr === null && !sub.ready; i++) {
        const answer = yield* ask(`refine-${n}/${i}`, {
          title: `#${n} ${sub.title}: no approved spec (needs-spec, or no acceptance criteria). Refine it outside this run.`,
          links: [{ label: `#${n}`, url: issueUrl(n) }],
          choices: [refined, "Stop the group"],
        });
        if (Option.isNone(answer) || answer.value.choice !== refined) return yield* stop(`#${n} has no approved spec`);
        sub = yield* step(`read-${n}/${i}`, { returns: Sub }, readSub(n));
      }
      if (!sub.open) continue;

      let pr = sub.pr;
      if (pr === null) {
        const worker = yield* agent(`build-${n}`, {
          project,
          workspace: { type: "worktree", baseRef: "origin/main", startFromOrigin: true },
          title: `[build] - #${n} ${sub.title}`,
          issue: { project, url: issueUrl(n) },
          model: { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "medium" }] },
          brief: brief(n),
          returns: Built,
          // ponytail: one idle hour, then the step asks for the result; a build that waits longer on
          // the owner gives up and pauses the run. Per-question waits if that bites.
          quiet: "1 hour",
          timeout: "24 hours",
        });
        built.push({ issue: n, ...worker.value });
        pr = worker.value.pr;
      }

      const end = yield* pullRequests.wait(`merged-${n}`, { project, url: pr }, { until: "merged" });
      if (Option.isNone(end) || end.value.state !== "merged") return yield* stop(`${pr} was closed without a merge`);
    }
    return { built };
  }),
);
