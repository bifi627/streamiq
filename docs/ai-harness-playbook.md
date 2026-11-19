# AI Workflow Harness — Playbook

Field notes on building the scaffolding that makes AI-agentic development produce
consistent, correct, maintainable code. General and portable — written to reference
when starting future projects. (Grew out of reviewing Frigorino, a brownfield project
that had to be restructured mid-flight; the goal here is to never need that restructure.)

---

## 1. What a harness is

The scaffolding around the model that makes its output consistent and correct
**regardless of which model, session, or prompt produced it.**

You do not make an LLM deterministic by prompting harder — it is probabilistic and
always will be. You make the *system* deterministic by surrounding the model with
deterministic checks and by shrinking the space of decisions it has to make.

### The one principle everything serves

> **Push every rule you can from prose (probabilistic) into tooling (deterministic).**

"Please remember to validate inputs" in a prompt is a suggestion the model can ignore.
A lint rule / type / test / generator that produces the validation is a rule it *cannot*
violate. Every rule moved from the instructions file into the toolchain is one fewer
thing that depends on the model behaving.

Graduation is a **move, not a copy**: when a rule becomes tooling, delete the prose.
Otherwise the instructions file accretes into exactly the giant rule file §7 warns about.

**Reframe:** a good AI harness is the same thing that makes a codebase good for humans —
clear conventions, fast feedback, tests, consistent structure. The difference is the AI
has no cross-session memory and far less context, so everything a senior human "just
knows" must be made *explicit* and, ideally, *enforced*.

---

## 2. Anatomy — the four layers

Concentric loops: what the model knows → what it's allowed to produce → what catches its
mistakes → how work flows through all three.

| Layer | Purpose | Key parts |
|---|---|---|
| **1. Context** | What the model knows before it acts | Terse always-on instructions file; on-demand architecture/knowledge docs (one citable unit per feature); **canonical example files to copy**; persistent memory; greppable, discoverable structure |
| **2. Constraint** | Narrow what it can produce | Templates & scaffolds; **codegen from a source of truth**; strong types & schemas; architecture-as-code (boundaries enforced, not described); schema-validated structured output |
| **3. Verification** | Catch mistakes deterministically | Fast local checks (type/lint/format); tests (unit for logic, integration on *real* deps); the **loop discipline** (run checks, read output, *then* claim done); behavioral/runtime verification; CI backstop; automated + human review |
| **4. Workflow** | How work flows through the above | Staged process (spec→plan→implement→verify) with review checkpoints; scope guardrails; codified procedures ("skills"); explicit definition-of-done; governance (permission allowlists, lifecycle hooks, secrets discipline, reversible branch/worktree model) |

**Determinism levers, ranked:**
1. Move rules prose → tooling (biggest lever)
2. Give examples, not descriptions
3. Delete decisions with codegen & templates (can't get wrong what it doesn't write)
4. Close the loop, always (run + read output before asserting done)
5. Fail loud and early (a type error now beats a review comment in three days)
6. Make structure greppable (retrieval failure looks like the model ignoring conventions)

### Verification is only as strong as its own defenses

Layer 3 rests on two assumptions that erode silently if unstated:

- **The model must not be able to cheat the check.** The most common agentic failure is
  not ignoring a check but *satisfying* it: weakening an assertion, deleting a failing
  test, adding a lint-disable, loosening a type. Checks are append-only by default;
  diffs that touch tests, lint config, or CI config get elevated review scrutiny.
  "Made the check pass" ≠ "made the code correct."
- **The loop only runs if it's cheap.** A check suite that drifts to ten minutes isn't
  skipped by announcement — discipline just erodes. Set a speed budget (inner loop in
  seconds, full check in a few minutes) and treat check-speed regressions as harness
  regressions.

---

## 3. Solutions & guardrails per layer

§2 in concrete form. For each part: the mechanism options that fill the slot
(stack-agnostic categories, well-known instances in parens) and the guardrail that keeps
it honest — every mechanism has a characteristic failure mode; the guardrail names it.

### Layer 1 — Context

| Part | Concrete options | Guardrail |
|---|---|---|
| Always-on instructions file | One terse file at repo root (CLAUDE.md / AGENTS.md); per-directory overlays for subsystem-specific rules | Hard budget (~1–2 pages). Every line earns its place; graduated rules get deleted (§1). Updated in the same change that invalidates it. |
| On-demand knowledge docs | `docs/` with an index the instructions file points to; one doc per feature/area; ADRs for decisions | Staleness — a wrong doc is worse than no doc. Update in the same PR that changes the area, or delete it. |
| Canonical examples | A real, blessed source file referenced by path ("new features copy `features/x`") | Exemplar rot: when a convention changes, the exemplar changes first, same PR. |
| Persistent memory | Gotcha log / memory dir the agent reads on start and appends to | Curation: dedupe, and expire entries once encoded as checks. An unbounded append-only log stops being read. |
| Greppable structure | Predictable naming, colocation, one concept = one place | If the model reinvents an existing util, treat it as a discoverability failure, not a model failure — fix the name/structure. |
| Current-docs fetching | Docs-fetching tooling (MCP docs servers, web fetch) for off-prior stacks | Fetched docs beat model prior whenever versions matter; only wire it where stale knowledge is a real risk. |

### Layer 2 — Constraint

| Part | Concrete options | Guardrail |
|---|---|---|
| Strong types & schemas | Type-checker at max strictness; runtime schema validation at trust boundaries (zod/pydantic-class) | Escape hatches: lint-ban `any` / casts / ignore-comments, or strictness quietly erodes. |
| Codegen from source of truth | API contract → clients + types (OpenAPI, protobuf, GraphQL); DB schema → types | Generated code is never hand-edited: CI regenerates and diffs — drift fails the build. |
| Templates & scaffolds | A scaffold command that stamps the feature skeleton from the exemplar | Extracted at the second occurrence, never earlier. Template and exemplar have one source, or they drift apart. |
| Architecture-as-code | Import/dependency rules (dependency-cruiser, ArchUnit-class, import-lint); compiler-level boundaries (project references, internal packages) | Violations fail the build — no warning-only mode. Rules tighten from observed violations only. |
| Structured output | JSON-schema validation for anything the model emits as data/config | Validate at the boundary, reject-and-retry; never parse prose. |

### Layer 3 — Verification

| Part | Concrete options | Guardrail |
|---|---|---|
| Fast local checks | Type-check + lint + format behind the one golden-path command; watch mode for the inner loop | Speed budget (§2). Zero-warning policy — warnings train everyone, model included, to ignore output. |
| Tests | Unit for pure logic; integration on *real* dependencies (containerized deps) over mocks | Append-only by default; test-file diffs get elevated scrutiny (§2). A deleted or weakened assertion must be justified in the PR. |
| Behavioral verification | Actually drive the changed flow: smoke script, e2e happy path, a run with output captured | The model shows observed output. "It should work now" is not evidence. |
| CI backstop | The same golden-path command as required check; no skip label | Local/CI drift is a harness bug. CI is authoritative. |
| Review | Automated pass first (AI review, static analysis); human on intent, boundaries, tests, dependencies | Spend human attention only where automation is blind — never on formatting. |

### Layer 4 — Workflow

| Part | Concrete options | Guardrail |
|---|---|---|
| Staged process | Written plan with an approval checkpoint before implementation; spec template with acceptance criteria | No implementation before definition-of-ready is met (§5). Plan sized to review bandwidth. |
| Scope guardrails | Explicit out-of-scope list per task; expected diff-size note | No drive-by fixes: unrelated improvements become new tasks, not diff growth. |
| Codified procedures ("skills") | Repeatable procedures as checklists/scripts the agent invokes (new-feature, migration, release) | Script the deterministic steps; prose only for the judgment calls. Extract at second occurrence. |
| Definition of done / ready | Checklists in the instructions file; DoD ends with "golden path ran, output read" | Lives in the repo, not in heads — otherwise it varies per session. |
| Governance | Permission allowlists; lifecycle hooks; secrets env-injected, never committed; branch/worktree isolation; protected paths | Destructive ops gated. The harness's own config (CI, lint, tests) is protected from casual model edits (§2). |

---

## 4. Portability — does it travel across tech stacks?

The **design** is fully portable; the **instantiation** is almost entirely stack-specific.
The stack decides how much harness you get *for free*.

| Tier | Ports? | Example |
|---|---|---|
| **The design** | Fully | Four-layer model, prose→tooling principle, workflow, loop discipline, doc conventions, anti-over-engineering stance |
| **The slots** | As categories | "You need a type-checker, linter, formatter, fast test runner, codegen path, CI gate, boundary-enforcer" — the slot is universal, what fills it isn't |
| **The contents** | Not at all | Actual rules, example files, generators, commands, test infra |

**How much the stack hands you for free** (the real dependency — ~2–3× effort swing):

- *Gives you a lot:* static typing (free continuous correctness check — the biggest free
  chunk), compiled (build is a gate), strong-convention ecosystems (Go/Rails/.NET/Phoenix —
  fewer decisions to get wrong + more training-data consensus), mature codegen (OpenAPI/protobuf).
- *Makes you buy it back:* dynamic/untyped (replace type-check with more tests + runtime schema
  validation like pydantic/zod), convention-poor ecosystems (JS — you impose what the ecosystem won't),
  young/niche stacks (weaker tooling *and* thinner training data).

**Second axis — how well the model already knows your stack.** A mainstream, stable,
well-conventioned stack means the model's prior already aligns with your harness (light
corrective load). Obscure/bleeding-edge means its prior fights you — needs more examples,
more explicit rules, and current-docs fetching to patch stale knowledge.

**Mental model:** the harness is a CI *philosophy* + a pipeline *template* — the philosophy
is universal, the YAML is specific.

---

## 5. Greenfield bootstrapping (evolution over time)

### The trap
"Make everything right from the start" ≠ "build the whole harness on day one."
**Conventions are discovered, not decreed** — a harness *crystallizes* patterns that already
exist; it can't invent them. Front-loading templates/rules/docs on an empty repo encodes
*guesses*, then you fight your own scaffolding when the guesses turn out wrong. That's
over-engineering in a best-practices costume.

Two failure modes, avoid both:
- **Brownfield → retrofit debt** (conventions not enforced early → inconsistent sediment →
  mid-project restructure). This is what happened to Frigorino.
- **Greenfield → premature-harness debt** (elaborate scaffolding for patterns that don't exist yet).

### Day 0 — cheap now, murderous to retrofit

| Decision | Why day 0 |
|---|---|
| **Stack chosen to fill harness slots for free** | Typed + compiled + well-conventioned + good codegen. Highest-leverage decision; greenfield is the only time you pick it freely. |
| **Architectural seams / boundaries** | Enforce layering *by code* (project refs / import rules) from commit 1. This is exactly what brownfield has to restructure *into*. |
| **Verification loop wired before feature #1** | CI skeleton, type-check, lint, formatter, one running test. Cheap now; cultural debt once the team habituates to skipping it. |
| **Reproducible environment + one golden-path command** | Pinned toolchain, lockfiles, one-command setup, local checks identical to CI. A single `make check`-style entry point, named in the instructions file — the model composes zero commands from memory. If local and CI disagree, loop discipline dies silently. |
| **Source-of-truth / codegen direction** | Contract-first vs. code-first bakes in hard; painful to reverse. |
| **Instructions file + memory + definition-of-done** | Start *empty but maintained* (update-in-same-change from commit 1). Content accretes. |

### Deferred — needs a real instance first

Templates · canonical example files · architecture-as-code beyond coarse boundaries ·
per-feature knowledge docs · codified feature-building skills.

**Rule of two/three:** build the first feature *by hand, well* — it becomes the exemplar.
At the *second* similar feature, extract the template, promote feature #1 to "canonical
example," write the pattern doc. Not before — the first instance teaches you what the
template should even be.

### The sequence

```
Day 0 (no feature code):
  stack · boundaries-as-code · CI skeleton · verify loop ·
  instructions skeleton · codegen direction · definition-of-done

Feature #1:  build by hand, carefully — this is the reference implementation. No template yet.
Feature #2:  it rhymes with #1 → NOW extract template + example + pattern doc.
             Every later feature mirrors the exemplar.
Ongoing:     memory accretes real gotchas · a feature doc per area ·
             boundary rules tighten as real violations get caught.
```

### Why this beats brownfield permanently
The harness and the code grow together at a **one-feature lag**, so they never drift far
enough apart to need a restructure. You never reverse-engineer conventions out of a mess —
you encode each one the moment it stabilizes. Enforcing "every feature mirrors the exemplar"
from feature #2 onward means the inconsistent sediment never accumulates.

**Most-skipped, don't-skip:** decide the **unit of work** and **definition of done** before
the first line of feature code, so the very first AI task runs the full loop. Size the unit
of work by **human review bandwidth** — what a reviewer can actually verify, not what the
model can produce in a session (far larger); review is the bottleneck, and this cap doubles
as the scope guardrail. Pair definition-of-done with a two-line **definition of ready**: a
task has acceptance criteria and an explicit out-of-scope list before the model sees it.
Process discipline is free on day 0 and unbuyable later.

---

## 6. Keeping the harness alive after day 0

The harness decays by default — code moves, prose doesn't. Maintenance is **event-driven,
not calendar-driven**: fixed triggers, each with a fixed response.

### Triggers

| Trigger | Response |
|---|---|
| A model mistake survives to human review — **twice** | It's two bugs: one in the code, one in the harness. Fix the code now; on the second occurrence encode the rule (check / example / memory entry) **in the same PR as the fix** — fix + vaccinate in one diff. A lint rule is the exception: it becomes a proposed `tech-debt` issue, never a lint-config change in the fix PR (#556). |
| You type the same correction into a prompt twice | That sentence belongs in the harness (instructions line or example), not in your chat history. |
| A pattern shows up a second time | Extract the template / exemplar / skill (rule of two, §5). |
| A check turns slow or flaky | Harness regression — fix or quarantine immediately. A flaky check teaches everyone, model included, to ignore red. |
| A convention changes | Exemplar and docs change first, in the same PR. |

### The graduation ladder

Every harness entry migrates toward deterministic over its lifetime:

```
chat correction → memory entry → instructions line → example → template/scaffold → check/codegen
probabilistic ─────────────────────────────────────────────────────────→ deterministic
```

Prose is a **waiting room, not a home** — each stage exists only because the next isn't
justified *yet*. When it is, move the entry and delete it from the stage before (§1).

### Pruning

Per milestone, or whenever the instructions file outgrows its budget: delete stale prose,
dead docs, and rules now enforced by tooling; confirm the exemplar is still canonical.
Cheap audit sensor: end significant tasks by asking the agent *"what in the instructions
or docs was missing, wrong, or unnecessary for this task?"* — it experiences the harness
fresh every session, which makes it a good staleness detector.

### Health signals (no dashboard)

- Repeated-mistake escape rate → trending to zero
- Golden-path runtime → inside its budget
- Instructions file size → flat or shrinking while the check count grows
- "I keep having to tell it X" frequency → falling

All four moving the right way means the harness compounds. Otherwise it's decorative.

---

## 7. What NOT to build (the lazy cut)

The harness is the easiest thing to over-engineer. Resist:

- **Custom orchestration frameworks / agent runtimes.** Your CI, linter, type-checker, and
  test runner already *are* most of the harness. Point the model at them; don't rebuild them.
- **Giant rule files nobody reads** — including the model, which pays tokens for every line.
  Terse-and-enforced beats exhaustive-and-ignored.
- **Abstraction layers "for the AI."** It reads normal code fine. Don't distort the
  architecture to accommodate it.
- **Rules in prose that could be a check.** If it can be a lint rule, it shouldn't be a paragraph.

> The best harness is ~80% *config + existing quality gates + a handful of docs and examples*,
> not a new software project. If building it feels like building an app, you've overshot.

The stance points both ways: the model over-engineers the **product** too — speculative
abstractions and, above all, unrequested dependencies. Cheapest gate: a new dependency
requires explicit justification, enforced as a lockfile-diff review trigger or CI check,
not as a prose plea.

---

## 8. Day-0 checklist

- [ ] Stack picked to maximize free slots (typed / compiled / well-conventioned / good codegen)
- [ ] Coarse architectural boundaries defined and enforced by code (not prose)
- [ ] CI skeleton green on an empty app: type-check + lint + format + one running test
- [ ] Reproducible environment: pinned toolchain, lockfiles, one-command setup, local checks = CI
- [ ] One golden-path check command exists and is named in the instructions file
- [ ] Source-of-truth / codegen direction decided (contract-first vs code-first)
- [ ] Instructions file created (terse: rules, commands, invariants, pointers)
- [ ] Persistent memory location established, maintenance habit set
- [ ] Definition of done + definition of ready + unit of work (sized by review bandwidth) written down
- [ ] Loop discipline stated: run checks and read output before claiming done
- [ ] Check-tampering policy stated: diffs to tests / lint config / CI get elevated scrutiny
- [ ] Dependency gate: new dependencies require explicit justification (lockfile-diff trigger)
- [ ] Off-prior stack (young / niche / bleeding-edge)? Wire current-docs fetching into the harness
- [ ] Deferred (do NOT build yet): templates, example files, per-feature docs, fine-grained
      boundary rules, feature skills — add at the second occurrence of each pattern
