// The library home's rows (Home.tsx): when it shows and what each row holds.
import { AppError, toAppError } from '../../shared/errors.ts'
import type { Item } from './items.ts'

// Each row loads on its own: one that fails shows its error, the others stay.
export type Shelf = Item[] | AppError
export type Lists = {
  resume: Shelf
  next: Shelf
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

/** All rows once settled; a warm revisit shows before Resume and Next up answer. */
export function homeLists(
  rows: { favorites?: Shelf; recent?: Shelf; views?: Shelf },
  live: { resume: Shelf | null; next: Shelf | null },
  warm: boolean,
): Lists | null {
  const { favorites, recent, views } = rows
  const { resume, next } = live
  if (!favorites || !recent || !views || !((resume && next) || warm))
    return null
  return { resume: resume ?? [], next: next ?? [], favorites, recent, views }
}

export const ok = (r: Shelf) => (r instanceof AppError ? [] : r)

/** The Resume spot, up to the rest in progress, Next up, Favorites, Recently added,
 * and whether the home has nothing at all to show (no items and no error). */
export function homeView(l: Lists) {
  const [spot, ...more] = ok(l.resume)
  const rows = Object.values(l)
  const empty = rows.every((r) => !(r instanceof AppError) && !r.length)
  return {
    spot,
    more,
    next: ok(l.next),
    favorites: ok(l.favorites),
    recent: ok(l.recent),
    empty,
  }
}
