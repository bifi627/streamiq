// Pure decisions of group.ts, kept apart so `node --test` reaches them (the workflow file needs T3's globals).

const listItem = /^\s*\d+\.\s+#(\d+)/;
// Its first sentence only: the reason after it names positions too ("1 sets what 2 reuses").
const orderLine = /^\s*\**Order:\**\s*([^.]*\d[^.]*)/;

/**
 * The open sub-issues in build order, or why there is none. `Order:` names list positions
 * (`1 → 2 → 3`) or issues (`#12 → #14`); without the line, the numbered list is the order.
 */
export function buildOrder(parentBody: string, open: readonly number[]): number[] | string {
  const lines = parentBody.split(/\r?\n/);
  const listed = lines.flatMap((l) => (listItem.exec(l) ?? []).slice(1).map(Number));
  const stated = lines.map((l) => orderLine.exec(l)).find(Boolean);
  if (!stated && lines.some((l) => /^\s*\**Order:/.test(l))) return "the parent's Order: line can't be read";
  const order = stated
    ? (stated[1].match(/#?\d+/g) ?? []).map((t) => (t.startsWith("#") ? Number(t.slice(1)) : listed[Number(t) - 1]))
    : listed;
  if (order.length === 0) return "the parent states no order";
  if (order.includes(undefined as never)) return "the parent's Order: names a list position that doesn't exist";
  const missing = open.filter((n) => !order.includes(n));
  if (missing.length > 0) return `missing from the parent's order: ${missing.map((n) => `#${n}`).join(", ")}`;
  return [...new Set(order)].filter((n) => open.includes(n));
}

/** An approved spec: no `needs-spec`, and an "Acceptance criteria" section with at least one item. */
export function isReady(labels: readonly string[], body: string): boolean {
  const criteria = body.split(/^## /m).find((s) => /^Acceptance criteria/i.test(s)) ?? "";
  return !labels.includes("needs-spec") && /^\s*[-*] /m.test(criteria);
}

export function fixes(prBody: string, issue: number): boolean {
  return new RegExp(String.raw`\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?) #${issue}\b`, "i").test(prBody);
}
