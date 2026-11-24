// Controls' handlers: media actions, the volume store, the stable
// click/key handlers and the key listener. No React: Controls.tsx owns the
// state and passes refs and setters in.
import type { RefObject } from 'react'
import { seekTarget, storedVolume } from './bar'
import { isBack } from '../library/items'
import { clamp, keyAction, type Action } from './keys'
import { noop } from '../../shared/noop'
import { event } from '../../shared/diag'

const HIDE_MS = 4000

// Media actions; plain functions so the component never mutates its props.
const toggle = (v: HTMLVideoElement) =>
  v.paused
    ? v
        .play()
        .catch(
          (e) => e.name !== 'AbortError' && event(`player: play failed: ${e}`),
        ) // AbortError: a pause came first
    : v.pause()
export const seekTo = (v: HTMLVideoElement, t: number) => {
  v.currentTime = t
  return t
}
const seekBy = (v: HTMLVideoElement, d: number, dur: number) =>
  seekTo(v, seekTarget(v.currentTime, d, dur || v.duration || 0))

// Volume + mute per device, restored when the player opens.
const VOL = 'streamiq.volume'
const MUTED = 'streamiq.muted'
export const loadVol = (v: HTMLVideoElement) => {
  try {
    const s = storedVolume(
      localStorage.getItem(VOL),
      localStorage.getItem(MUTED),
    )
    v.volume = s.volume
    v.muted = s.muted
  } catch {
    v.volume = 0.5 // storage blocked (private mode)
  }
}
// Saved by the action itself, not on volumechange: a load (hls.js attaching,
// a quality switch) cancels the element's pending events, so a change made
// just before one never fires it.
const saveVol = (v: HTMLVideoElement) => {
  try {
    localStorage.setItem(VOL, String(v.volume))
    localStorage.setItem(MUTED, v.muted ? '1' : '0')
  } catch {
    /* storage blocked: this session only */
  }
}
const mute = (v: HTMLVideoElement) => {
  v.muted = !v.muted
  saveVol(v)
}
export const setVol = (v: HTMLVideoElement, x: number) => {
  v.volume = Math.max(0, Math.min(1, x))
  v.muted = v.volume === 0
  saveVol(v)
}

/** The settings popover's page: closed, main, or that setting's options. */
export type Page = null | 'main' | number

/** The bar's DOM and the props the stable handlers read (all refs). */
export type Refs = {
  video: RefObject<HTMLVideoElement | null>
  root: RefObject<HTMLDivElement | null>
  bar: RefObject<HTMLDivElement | null>
  play: RefObject<HTMLButtonElement | null>
  menuRow: RefObject<HTMLDivElement | null>
  qBtn: RefObject<HTMLButtonElement | null>
  timer: RefObject<number>
  back: RefObject<() => void>
  dur: RefObject<number>
  blocked: RefObject<boolean>
}

// Handlers for clicks and the key listener; only touch refs and setters.
export function makeUi(
  r: Refs,
  setShown: (x: boolean) => void,
  setPage: (p: Page) => void,
  setTime: (t: number) => void,
) {
  const ui = {
    stop: () => clearTimeout(r.timer.current),
    hide() {
      clearTimeout(r.timer.current)
      setShown(false)
      setPage(null)
      // the privacy explanation shuts with the bar
      r.bar.current
        ?.querySelector<HTMLElement>('.badge[aria-expanded="true"]')
        ?.click()
      if (r.bar.current?.contains(document.activeElement))
        r.root.current?.focus({ preventScroll: true })
    },
    poke() {
      setShown(true)
      clearTimeout(r.timer.current)
      r.timer.current = window.setTimeout(() => {
        if (!r.blocked.current) ui.hide()
      }, HIDE_MS)
    },
    /** Close the popover, focus back on the gear. */
    close() {
      setPage(null)
      r.qBtn.current?.focus({ preventScroll: true })
    },
    toggle: () => r.video.current && toggle(r.video.current),
    mute: () => r.video.current && mute(r.video.current),
    seek: (d: number) =>
      r.video.current && setTime(seekBy(r.video.current, d, r.dur.current)),
    fullscreen() {
      if (document.fullscreenElement) return document.exitFullscreen()
      r.root.current
        ?.requestFullscreen()
        // Phones: landscape while fullscreen (rejected on desktop; ignored).
        .then(() =>
          (
            screen.orientation as ScreenOrientation & {
              lock?: (o: string) => Promise<void>
            }
          )
            .lock?.('landscape')
            .catch((e) => event(`player: landscape lock failed: ${e}`)),
        )
        .catch((e) => event(`player: fullscreen failed: ${e}`))
    },
  }
  return ui
}
export type Ui = ReturnType<typeof makeUi>

/** A key anywhere: reads the DOM, lets keyAction() decide, runs the result. */
export function onKey(
  e: KeyboardEvent,
  v: HTMLVideoElement,
  r: Refs,
  ui: Ui,
  setPage: (p: Page) => void,
) {
  const t = e.target as Element
  if (t !== document.body && !r.root.current?.contains(t)) return // other UI
  const a = document.activeElement as HTMLElement
  const bar = r.bar.current
  const pop = r.menuRow.current
  // Rendered items only: inline, the top row's badge is display: none.
  const items = (x: Element) =>
    Array.from(x.querySelectorAll<HTMLElement>('button, input')).filter(
      (i) => i.getClientRects().length,
    )
  const rows = Array.from(bar?.querySelectorAll('[data-row]') ?? []).filter(
    (x) => items(x).length,
  )
  const row = rows.findIndex((x) => x.contains(a))
  // Down from the last row: the diagnostics dock, if it's on; not
  // in fullscreen, where it isn't shown.
  const dock = document.querySelector<HTMLElement>('.dock-bar')
  const goBack = isBack(e)
  const action = keyAction({
    back: goBack,
    key: e.key.toLowerCase(),
    page: pop ? (pop.dataset.page === 'main' ? 'main' : 'options') : null,
    inPopover: !!pop?.contains(a),
    inBar: !!bar?.contains(a),
    shown: bar?.dataset.shown === 'true',
    seek: !!a.dataset.seek,
    volume: !!a.dataset.volume,
    lastRow: row === rows.length - 1,
    dock: !!dock && !document.fullscreenElement,
    ctrl: e.ctrlKey,
    meta: e.metaKey,
    alt: e.altKey,
    repeat: e.repeat,
  })
  if (!goBack) ui.poke()
  if (!action) return
  e.preventDefault() // also Back: the browser's own would leave the player
  const move = (its: HTMLElement[], by: number) =>
    its[clamp(its.indexOf(a) + by, its.length)]?.focus()
  const run: {
    [K in Action['do']]: (x: Extract<Action, { do: K }>) => unknown
  } = {
    close: ui.close,
    up: () => setPage('main'),
    hide: ui.hide,
    exit: () => r.back.current(),
    fullscreen: ui.fullscreen,
    mute: ui.mute,
    toggle: ui.toggle,
    seek: (x) => ui.seek(x.by),
    focusPlay: () => r.play.current?.focus(),
    stay: noop,
    option: (x) =>
      move(
        Array.from(
          pop?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [],
        ),
        x.by,
      ),
    item: (x) => move(items(rows[row]), x.by),
    row: (x) =>
      items(rows[(row + x.by + rows.length) % rows.length])[0].focus(),
    volume: (x) => setVol(v, v.volume + x.by),
    dock: () => dock?.focus(),
  }
  ;(run[action.do] as (x: Action) => unknown)(action)
}
