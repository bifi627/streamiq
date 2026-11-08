// Jellyfin item shape (the fields the UI reads) + pure helpers (no DOM, so
// node --test can import this file).
export type Item = {
  Id: string
  Name: string
  Type: string
  IsFolder?: boolean
  SeriesId?: string
  RunTimeTicks?: number
  ProductionYear?: number
  IndexNumber?: number
  ImageTags?: { Primary?: string }
  UserData?: { PlaybackPositionTicks?: number; Played?: boolean }
}

export const clock = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** hls.js ranges have an exclusive end; HTTP Range's end is inclusive. */
export function rangeHeader(start?: number, end?: number) {
  if (start == null && end == null) return undefined
  return `bytes=${start ?? 0}-${end ? end - 1 : ''}`
}

/** Jellyfin time unit: 100 ns ticks. */
export const TICKS_PER_SECOND = 10_000_000

/** Video appends in a row that may leave the playhead without video before
 * the player gives up on stream copy (#81: webOS drops stream-copied open-GOP
 * h264 after a seek/resume; the appends "succeed" but buffer nothing). */
export const STUCK_APPENDS = 4

type Ranges = {
  length: number
  start(i: number): number
  end(i: number): number
}

/** Whether a (video) buffered range covers t. 1 s slack: a fragment's first
 * frame can land just after the requested position. */
export const covers = (r: Ranges | undefined, t: number) =>
  !!r &&
  Array.from({ length: r.length }).some(
    (_, i) => r.start(i) - 1 <= t && t <= r.end(i) + 1,
  )
