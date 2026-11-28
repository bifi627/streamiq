// One playback's quality summary: one item in the player, from its first load
// until the player closes or moves on. A reload (quality, audio, a replaced tunnel)
// stays the same playback. The gateway keeps it on the tunnel's history line.
import type { Playback } from '../../generated/tunnel'

const TICK = 1000

/** Seconds really played between two samples: media time that moved forward, at
 * most the wall time that passed, so a seek or a reload adds a second at most. */
export const played = (media: number, wall: number) =>
  media > 0 ? Math.min(media, wall) : 0

/** The main-thread stall a TICK timer saw: how late it fired, ms. A hidden page's
 * throttled timers aren't a stall. */
export const lag = (ms: number, hidden: boolean) =>
  hidden ? 0 : Math.max(0, Math.round(ms - TICK))

type Frames = { dropped: number; total: number }

/** Adds a frame-counter sample to the running sum: a reload attaches new media,
 * which restarts the element's counters, so the earlier totals go into `base`. */
export function frames(f: { base: Frames; last: Frames }, now: Frames) {
  if (now.total < f.last.total)
    f.base = {
      dropped: f.base.dropped + f.last.dropped,
      total: f.base.total + f.last.total,
    }
  f.last = now
  return {
    dropped: f.base.dropped + now.dropped,
    total: f.base.total + now.total,
  }
}

/** What the current load plays: set on each load. */
export type Load = Pick<Playback, 'codec' | 'quality' | 'remux'>

/** Measures one playback on `v`; end() stops it and returns the summary, once
 * (null after). */
export function track(v: HTMLVideoElement, itemId: string) {
  const p: Playback = {
    itemId,
    codec: '',
    width: 0,
    height: 0,
    quality: '',
    remux: false,
    playedSec: 0,
    droppedFrames: 0,
    totalFrames: 0,
    worstStallMs: 0,
    waits: 0,
  }
  let sec = 0
  let at = v.currentTime
  let prev = performance.now()
  const f = { base: { dropped: 0, total: 0 }, last: { dropped: 0, total: 0 } }
  // The tick after a hidden spell is late too, also when timers stopped outright.
  let hidden = document.hidden
  const hide = () => (hidden ||= document.hidden)
  document.addEventListener('visibilitychange', hide)
  // From the first second played: startup's wait for data and jank aren't hitches.
  const waiting = () => sec > 0 && p.waits++
  v.addEventListener('waiting', waiting)
  const t = setInterval(() => {
    const now = performance.now()
    p.worstStallMs = Math.max(
      p.worstStallMs,
      sec > 0 ? lag(now - prev, hidden || document.hidden) : 0,
    )
    hidden = document.hidden
    sec += played(v.paused ? 0 : v.currentTime - at, (now - prev) / 1000)
    at = v.currentTime
    prev = now
    if (v.videoWidth) [p.width, p.height] = [v.videoWidth, v.videoHeight]
    const q = v.getVideoPlaybackQuality?.()
    if (q) {
      const n = frames(f, {
        dropped: q.droppedVideoFrames,
        total: q.totalVideoFrames,
      })
      ;[p.droppedFrames, p.totalFrames] = [n.dropped, n.total]
    }
  }, TICK)
  let over = false
  return {
    load: (l: Load) => Object.assign(p, l),
    end(): Playback | null {
      if (over) return null
      over = true
      clearInterval(t)
      v.removeEventListener('waiting', waiting)
      document.removeEventListener('visibilitychange', hide)
      return { ...p, playedSec: Math.round(sec) }
    },
  }
}

const LAST = 'streamiq.lastPlayback'

/** Sends a summary (`post` = over the tunnel) and keeps its line as this browser's
 * last; a failure (an older gateway's 404, a dead tunnel) is only `log`ged. */
export function send(
  p: Playback,
  post: (p: Playback) => Promise<unknown>,
  log: (msg: string) => void,
) {
  try {
    localStorage.setItem(LAST, line(p))
  } catch {
    /* storage blocked: no last playback */
  }
  return post(p).then(
    () => undefined,
    (e) => log(`playback: summary not stored: ${e}`),
  )
}

/** This browser's last summary as line() put it; null = none. */
export function lastPlayback() {
  try {
    return localStorage.getItem(LAST)
  } catch {
    return null
  }
}

const n = (x: number) => x.toLocaleString()
const unit = (u: string, x: number) =>
  new Intl.NumberFormat(undefined, {
    style: 'unit',
    unit: u,
    unitDisplay: 'short',
  }).format(x)

/** "hevc 1920×1080 · Source · remux · 12 min · 312 of 43,210 frames dropped ·
 * worst stall 840 ms · 3 waits" */
export function line(p: Playback) {
  return [
    `${p.codec || '?'} ${p.width}×${p.height}`,
    p.quality || '?',
    p.remux ? 'remux' : 'transcode',
    p.playedSec < 60
      ? unit('second', p.playedSec)
      : unit('minute', Math.round(p.playedSec / 60)),
    `${n(p.droppedFrames)} of ${n(p.totalFrames)} frames dropped`,
    `worst stall ${unit('millisecond', p.worstStallMs)}`,
    `${n(p.waits)} ${p.waits === 1 ? 'wait' : 'waits'}`,
  ].join(' · ')
}
