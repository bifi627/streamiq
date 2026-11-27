// The folder view's pages: a folder's children load 50 at a time.
import type { Item } from './items.ts'

export const PAGE = 50
export type Page = { Items: Item[]; TotalRecordCount?: number }

/** startIndex of the page after `pages`, or undefined after the last one.
 * A short page ends it too (no TotalRecordCount, or a folder that shrank). */
export function nextStart(pages: Page[]): number | undefined {
  const last = pages[pages.length - 1] // no .at(): Chrome 87 (TV)
  if (!last || last.Items.length < PAGE) return undefined
  const loaded = pages.reduce((n, p) => n + p.Items.length, 0)
  return loaded < (last.TotalRecordCount ?? Infinity) ? loaded : undefined
}

/** What the grid shows: every loaded item once (a folder that changed between
 * pages can repeat one), and what follows it: the next page loading or due,
 * a failed page's Retry, or nothing. undefined = the first page isn't there. */
export function folderView(q: {
  pages?: Page[]
  hasNext: boolean
  nextFailed: boolean
  fetching: boolean
}) {
  if (!q.pages) return undefined
  const seen = new Set<string>()
  const items = q.pages
    .flatMap((p) => p.Items)
    .filter((i) => !seen.has(i.Id) && seen.add(i.Id))
  // fetching first: a Retry's refetch keeps the error until it settles
  const tail: 'loading' | 'retry' | 'more' | 'end' = q.fetching
    ? 'loading'
    : q.nextFailed
      ? 'retry'
      : q.hasNext
        ? 'more'
        : 'end'
  return { items, tail }
}
