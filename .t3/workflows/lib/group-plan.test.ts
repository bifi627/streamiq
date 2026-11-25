import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOrder, fixes, isReady } from "./group-plan.ts";

const list = "1. #324 Layout check\n2. #326 Spike\n3. #325 Editor\n";

test("Order: by list position wins over the list, closed ones drop out", () => {
  assert.deepEqual(buildOrder(`${list}Order: 1 → 3 → 2. 1 sets what 2 reuses.`, [326, 325]), [325, 326]);
});

test("Order: by issue number; no Order: line → the numbered list", () => {
  assert.deepEqual(buildOrder("Order: #5 -> #4", [4, 5]), [5, 4]);
  assert.deepEqual(buildOrder(list, [324, 326, 325]), [324, 326, 325]);
});

test("no usable order is a reason, not a guess", () => {
  assert.equal(buildOrder("no list", [1]), "the parent states no order");
  assert.equal(buildOrder(`${list}Order: see below`, [324]), "the parent's Order: line can't be read");
  assert.match(buildOrder(`${list}Order: 1 → 4`, [324]) as string, /position/);
  assert.equal(buildOrder(list, [324, 999]), "missing from the parent's order: #999");
});

test("isReady needs criteria and no needs-spec", () => {
  const body = "## Why\nx\n## Acceptance criteria\n- [ ] a\n## Out of scope\n- b\n";
  assert.equal(isReady(["p2"], body), true);
  assert.equal(isReady(["needs-spec"], body), false);
  assert.equal(isReady([], "## Acceptance criteria\n\n## Out of scope\n- b\n"), false);
});

test("fixes matches the closing keyword for that issue only", () => {
  assert.equal(fixes("Fixes #94", 94), true);
  assert.equal(fixes("Fixes #944", 94), false);
  assert.equal(fixes("see #94", 94), false);
});
