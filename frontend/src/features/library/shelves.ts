// The library home's rows (Home.tsx): when it shows and what each row holds.
import { AppError, toAppError } from '../../shared/errors.ts'
import type { Item } from './items.ts'

// Each row loads on its own: one that fails shows its error, the others stay.
export type Shelf = Item[] | AppError
export type Lists = {
  resume: Shelf
  favorites: Shelf
  recent: Shelf
  views: Shelf
}

/** A row from its query: the items, its error, or undefined while loading. */
export const shelf = (q: {
  data?: { Items: Item[] }
  error: unknown
}): Shelf | undefined =>
  q.data ? q.data.Items : q.error ? toAppError(q.error) : undefined

/** All rows once settled; a warm revisit shows before Resume answers. */
export function homeLists(
  rows: { favorites?: Shelf; recent?: Shelf; views?: Shelf },
  resume: Shelf | null,
  warm: boolean,
): Lists | null {
  const { favorites, recent, views } = rows
  if (!favorites || !recent || !views || !(resume || warm)) return null
  return { resume: resume ?? [], favorites, recent, views }
}

export const ok = (r: Shelf) => (r instanceof AppError ? [] : r)

/** The Resume spot, up to the rest in progress, Favorites, Recently added, and whether
 * the home has nothing at all to show (no items and no error). */
export function homeView(l: Lists) {
  const [spot, ...more] = ok(l.resume)
  const favorites = ok(l.favorites)
  const recent = ok(l.recent)
  const failed = Object.values(l).some((r) => r instanceof AppError)
  const empty =
    !spot &&
    !favorites.length &&
    !recent.length &&
    !ok(l.views).length &&
    !failed
  return { spot, more, favorites, recent, empty }
}
