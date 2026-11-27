// Library search's decisions (LibraryHome.tsx).
import { years, type Item } from './items.ts'

/** The term to search for, or null: under 2 characters lists too much. */
export function searchTerm(text: string | undefined) {
  const t = (text ?? '').trim()
  return t.length >= 2 ? t : null
}

export const qSearch = (text: string) => (text ? { q: text } : {})

/** The field's text once ?q= changed: the field's own push keeps what was
 * typed since; any other change (Back, the nav's Library link) replaces it. */
export const fieldText = (text: string, q: string, pushed: string) =>
  q === pushed ? text : q

/** An episode: series + season (its title has the number); else the years. */
export const resultLine = (i: Item) =>
  i.Type === 'Episode'
    ? [
        i.SeriesName,
        i.ParentIndexNumber != null && `Season ${i.ParentIndexNumber}`,
      ]
        .filter(Boolean)
        .join(' · ')
    : years(i)
