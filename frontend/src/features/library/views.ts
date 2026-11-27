// Watch history's decisions (WatchHistory.tsx, resume.ts): the gateway keeps one
// line per playback (GET/POST /streamiq/views); titles and art come from Jellyfin.
import { describe, type AppError } from '../../shared/errors.ts'
import { ViewsPath, type View } from '../../generated/history.ts'
import type { Item } from './items.ts'

export type { View }
export const VIEWS = ViewsPath

/** Seconds really played before a playback counts as a view. */
export const VIEW_MIN = 10

/** The distinct items of `views`, in chunks of `n` ids (one jf.byIds call each). */
export function idChunks(views: View[], n = 100) {
  const ids = [...new Set(views.map((v) => v.itemId))]
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += n) out.push(ids.slice(i, i + n))
  return out
}

/** One entry per view, newest first as the gateway answers; a view of an
 * item Jellyfin no longer has is left out. */
export type Entry = { view: View; item: Item }
export function entries(views: View[], items: Item[]): Entry[] {
  const byId = new Map(items.map((i) => [i.Id, i]))
  return views.flatMap((view) => {
    const item = byId.get(view.itemId)
    return item ? [{ view, item }] : []
  })
}

/** When it was watched; an episode leads with its series and S·E. */
export function viewLine(i: Item, at: string) {
  const when = new Date(at).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  if (i.Type !== 'Episode') return when
  const se = `S${i.ParentIndexNumber ?? '?'}E${i.IndexNumber ?? '?'}`
  return [i.SeriesName, se, when].filter(Boolean).join(' · ')
}

// A gateway older than GET /streamiq/views answers 404.
export const viewsMessage = (e: AppError) =>
  e.context.status === 404
    ? 'This gateway is too old to keep a watch history: update it.'
    : describe(e).message
