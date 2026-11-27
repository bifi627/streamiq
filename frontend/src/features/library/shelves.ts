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

/** The rows top to bottom, Resume being the spot. */
export const order = ['resume', 'next', 'favorites', 'recent', 'views'] as const
export const titles = {
  resume: 'Continue watching',
  next: 'Next up',
  favorites: 'Favorites',
  recent: 'Recently added',
  views: 'Library',
}
// Resume and Next up answer after a warm home shows: one that joins then
// would pull focus from where the user already moved it.
const late = (k: string, warm: boolean) =>
  warm && (k === 'resume' || k === 'next')

/** The Resume spot, up to the rest in progress, the row whose first item takes
 * first focus (the top one with items, not a late one on a warm home), and
 * whether the home has nothing at all to show (no items and no error). */
export function homeView(l: Lists, warm = false) {
  const [spot, ...more] = ok(l.resume)
  const filled = order.filter((k) => ok(l[k]).length)
  const first = filled.find((k) => !late(k, warm))
  const failed = order.some((k) => l[k] instanceof AppError)
  return { spot, more, first, empty: !filled.length && !failed }
}
