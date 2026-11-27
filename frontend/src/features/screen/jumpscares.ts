// Jump scares: the times of an item's scares, read from a
// whenjumpscare.com .srt on the phone and kept in this browser only.
import { clock } from '../library/items.ts'

export type JumpScare = { at: number; major: boolean } // at: seconds

// whenjumpscare cue text: "⚠️ Minor jumpscare approaching at 00:50:08". The
// time in the text is the scare's; the cue itself starts 5 s earlier.
const CUE = /\b(major|minor)\s+jump\s*scare\b.*?\bat\s+(\d+):(\d\d):(\d\d)/i

/** Every jump scare in an .srt's text, by time; [] = none found. */
export function parseJumpScares(srt: string): JumpScare[] {
  const out: JumpScare[] = []
  for (const line of srt.split(/\r?\n/)) {
    const m = CUE.exec(line)
    if (m)
      out.push({
        at: Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]),
        major: m[1].toLowerCase() === 'major',
      })
  }
  return out.sort((a, b) => a.at - b.at)
}

/** The first scare after pos (seconds), or undefined after the last. */
export const nextJumpScare = (list: JumpScare[], pos: number) =>
  list.find((s) => s.at > pos)

/** The remote's line for the scare after pos. */
export function jumpScareHint(list: JumpScare[], pos: number) {
  const next = nextJumpScare(list, pos)
  if (!next) return 'No more jump scares'
  return `Next jump scare in ${clock(next.at - pos)} (${next.major ? 'major' : 'minor'})`
}

const key = (itemId: string) => `streamiq:jumpscares:${itemId}`

// localStorage itself throws when site data is blocked: read it inside the try.
const browser = () => globalThis.localStorage as Storage | undefined

/** The stored list for an item; [] without one or without storage. */
export function loadJumpScares(itemId: string, store = browser): JumpScare[] {
  try {
    const v: unknown = JSON.parse(store()?.getItem(key(itemId)) ?? '[]')
    return Array.isArray(v) ? (v as JumpScare[]) : []
  } catch {
    return []
  }
}

/** Replaces the item's list; false = storage unavailable or full. */
export function saveJumpScares(
  itemId: string,
  list: JumpScare[],
  store = browser,
) {
  try {
    const s = store()
    if (!s) return false
    s.setItem(key(itemId), JSON.stringify(list))
    return true
  } catch {
    return false
  }
}

/** An .srt picked on the remote: the list to show (undefined = keep the
 * current one) and the message for the user ('' = none). No match stores
 * nothing, so a wrong file never wipes a good list. */
export function importJumpScares(
  itemId: string,
  srt: string,
  store = browser,
): { list?: JumpScare[]; msg: string } {
  const list = parseJumpScares(srt)
  if (!list.length) return { msg: 'No jump scares found in this file' }
  const saved = saveJumpScares(itemId, list, store)
  return { list, msg: saved ? '' : "Couldn't save on this device" }
}
