// Library search (LibraryHome.tsx): when a typed text searches, and a result's
// second card line.
import { years, type Item } from './items.ts'

/** The term to search for, or null: under 2 characters lists too much. */
export function searchTerm(text: string | undefined) {
  const t = (text ?? '').trim()
  return t.length >= 2 ? t : null
}

/** An episode names its series and place in it; anything else, its years. */
export const resultLine = (i: Item) =>
  i.Type === 'Episode'
    ? [
        i.SeriesName,
        i.ParentIndexNumber != null &&
          i.IndexNumber != null &&
          `S${i.ParentIndexNumber} · E${i.IndexNumber}`,
      ]
        .filter(Boolean)
        .join(' · ')
    : years(i)
