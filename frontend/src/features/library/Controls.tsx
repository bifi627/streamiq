// Own control bar over <video> (#91): one UI for TV remote (D-pad), touch,
// mouse and keyboard. Key model:
// - Focus outside the bar (bar hidden, or shown by a pointer/seek key):
//   ←/→ seek ±10 s, Enter/Space/K play-pause, ↑/↓ focus play/pause.
// - Focus inside the bar: ←/→ move focus within a row (on the seek bar: seek),
//   ↑/↓ switch between the seek row and the button row (on volume: ±10 %).
// - Back (Escape, webOS 461/GoBack): hides the bar if shown, else exits.
// - F fullscreen, M mute, anywhere. Any key / mouse move shows the bar; it hides
//   after HIDE_MS (playing or paused; it stays only while autoplay is blocked).
// - Mouse (and Magic Remote pointer) on the picture: click play-pause, double
//   click fullscreen. Touch: tap toggles the bar.
// - Settings (#108, #153): the gear opens a popover over the picture: a main
//   page with one row per setting (name + current value), each opening its
//   options page. ↑/↓ move, Enter opens / picks (and closes), Back goes up one
//   page, then closes. A click outside closes it. One button for every setting,
//   so the bar stays one row on a phone and the remote model stays ↑/↓ + Enter.
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { clock } from './items'
import './Player.css'

const HIDE_MS = 4000
const SKIP = 10

// Material icon paths (24×24).
const ICON = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  sound:
    'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  muted:
    'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  full: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  unfull:
    'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
}
const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d={d} />
  </svg>
)

// Media actions; plain functions so the component never mutates its props.
const toggle = (v: HTMLVideoElement) =>
  v.paused ? v.play().catch(() => {}) : v.pause()
const mute = (v: HTMLVideoElement) => {
  v.muted = !v.muted
}
const seekTo = (v: HTMLVideoElement, t: number) => {
  v.currentTime = t
  return t
}
const seekBy = (v: HTMLVideoElement, d: number, dur: number) =>
  seekTo(v, Math.max(0, Math.min(dur || v.duration || 0, v.currentTime + d)))
const setVol = (v: HTMLVideoElement, x: number) => {
  v.volume = Math.max(0, Math.min(1, x))
  v.muted = v.volume === 0
}

/** One entry of the settings menu (quality, later audio #109, subtitles #136). */
export type Setting = {
  name: string
  value: string
  options: { value: string; label: string; hint?: string; disabled?: boolean }[]
  /** What is in effect, shown next to the value (e.g. "Original 4K"). */
  status?: string
  pick: (value: string) => void
}

/** The settings popover's page: closed, main, or that setting's options. */
type Page = null | 'main' | number

const isBack = (e: KeyboardEvent) =>
  e.key === 'Escape' ||
  e.key === 'GoBack' ||
  e.key === 'BrowserBack' ||
  e.keyCode === 461 // webOS remote

export function Controls({
  video,
  duration,
  blocked,
  settings,
  onBack,
  children,
}: {
  video: RefObject<HTMLVideoElement | null>
  duration: number
  blocked: boolean
  settings: Setting[]
  onBack: () => void
  children: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const play = useRef<HTMLButtonElement>(null)
  const [shown, setShown] = useState(true)
  const [paused, setPaused] = useState(true)
  const [time, setTime] = useState(0)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [full, setFull] = useState(false)
  const [page, setPage] = useState<Page>(null)
  const [from, setFrom] = useState(0) // setting whose page was open last (main focuses it)
  const menuRow = useRef<HTMLDivElement>(null)
  const qBtn = useRef<HTMLButtonElement>(null)
  const timer = useRef(0)
  // Handlers live in refs (stable for the key listener); these keep them current.
  const back = useRef(onBack)
  const dur = useRef(duration)
  const isBlocked = useRef(blocked)
  const pointer = useRef('') // last pointerType: clicks act only for a mouse
  useEffect(() => {
    back.current = onBack
    dur.current = duration
    isBlocked.current = blocked
  })

  // Handlers for clicks and the key listener; only touch refs and setters.
  const [ui] = useState(() => {
    const ui = {
      hide() {
        clearTimeout(timer.current)
        setShown(false)
        setPage(null)
        if (bar.current?.contains(document.activeElement))
          root.current?.focus({ preventScroll: true })
      },
      poke() {
        setShown(true)
        clearTimeout(timer.current)
        timer.current = window.setTimeout(() => {
          if (!isBlocked.current) ui.hide()
        }, HIDE_MS)
      },
      toggle: () => toggle(video.current!),
      mute: () => mute(video.current!),
      seek: (d: number) => setTime(seekBy(video.current!, d, dur.current)),
      fullscreen() {
        if (document.fullscreenElement) return document.exitFullscreen()
        root.current
          ?.requestFullscreen()
          // Phones: landscape while fullscreen (rejected on desktop; ignored).
          .then(() =>
            (
              screen.orientation as ScreenOrientation & {
                lock?: (o: string) => Promise<void>
              }
            )
              .lock?.('landscape')
              .catch(() => {}),
          )
          .catch(() => {})
      },
    }
    return ui
  })

  useEffect(() => {
    const v = video.current!
    const sync = () => {
      setPaused(v.paused)
      // No frame yet (a reload, #109): currentTime reads 0 until the new
      // stream seeks to the playhead; keep the bar where it was.
      if (v.readyState >= v.HAVE_CURRENT_DATA) setTime(v.currentTime)
      setMuted(v.muted)
      setVolume(v.volume)
    }
    const playing = () => {
      sync()
      ui.poke() // restart the hide countdown
    }
    const fs = () => setFull(!!document.fullscreenElement)
    const evs = ['pause', 'timeupdate', 'volumechange', 'seeked'] as const
    evs.forEach((e) => v.addEventListener(e, sync))
    v.addEventListener('play', playing)
    document.addEventListener('fullscreenchange', fs)

    const key = (e: KeyboardEvent) => {
      const t = e.target as Element
      if (t !== document.body && !root.current?.contains(t)) return // other UI
      const inBar = !!bar.current?.contains(document.activeElement)
      const pop = menuRow.current
      if (isBack(e)) {
        e.preventDefault() // the browser's own Back would leave the player too
        if (pop?.dataset.page === 'main') {
          setPage(null)
          qBtn.current?.focus({ preventScroll: true })
        } else if (pop) setPage('main')
        else if (inBar || bar.current?.dataset.shown === 'true') ui.hide()
        else back.current()
        return
      }
      ui.poke()
      const k = e.key.toLowerCase()
      const left = k === 'arrowleft'
      const horizontal = left || k === 'arrowright'
      const vertical = k === 'arrowup' || k === 'arrowdown'
      const act = (f: () => unknown) => {
        e.preventDefault()
        f()
      }
      if (k === 'f') return act(ui.fullscreen)
      if (k === 'm') return act(ui.mute)
      if (k === 'k') return act(ui.toggle)
      if (pop?.contains(document.activeElement)) {
        // The popover: ↑/↓ through its options, ←/→ do nothing.
        if (!horizontal && !vertical) return
        e.preventDefault()
        const its = Array.from(
          pop.querySelectorAll<HTMLElement>('button:not(:disabled)'),
        )
        const i = its.indexOf(document.activeElement as HTMLElement)
        if (vertical)
          its[
            Math.max(
              0,
              Math.min(its.length - 1, i + (k === 'arrowup' ? -1 : 1)),
            )
          ].focus()
        return
      }
      if (!inBar) {
        if (horizontal) act(() => ui.seek(left ? -SKIP : SKIP))
        else if (k === 'enter' || k === ' ') act(ui.toggle)
        else if (vertical) act(() => play.current?.focus())
        return
      }
      // Roving focus inside the bar; Enter/Space activate the focused control.
      if (!horizontal && !vertical) return
      e.preventDefault()
      const a = document.activeElement as HTMLElement
      const rows = Array.from(bar.current!.querySelectorAll('[data-row]'))
      const row = rows.findIndex((r) => r.contains(a))
      const items = (r: Element) =>
        Array.from(r.querySelectorAll<HTMLElement>('button, input'))
      if (horizontal) {
        if (a.dataset.seek) return ui.seek(left ? -SKIP : SKIP)
        const its = items(rows[row])
        const i = its.indexOf(a) + (left ? -1 : 1)
        its[Math.max(0, Math.min(its.length - 1, i))].focus()
      } else if (a.dataset.volume) {
        setVol(v, v.volume + (k === 'arrowup' ? 0.1 : -0.1))
      } else {
        const next = row + (k === 'arrowup' ? -1 : 1) + rows.length
        items(rows[next % rows.length])[0].focus()
      }
    }
    window.addEventListener('keydown', key)
    return () => {
      evs.forEach((e) => v.removeEventListener(e, sync))
      v.removeEventListener('play', playing)
      document.removeEventListener('fullscreenchange', fs)
      window.removeEventListener('keydown', key)
      clearTimeout(timer.current)
    }
  }, [video, ui])

  // Autoplay blocked: the bar stays up (paused) with Play focused, so one
  // Enter/tap starts playback.
  useEffect(() => {
    if (blocked) play.current?.focus({ preventScroll: true })
  }, [blocked])

  // Each page focuses its [data-focus] item (D-pad lands in it): on the main
  // page the setting just left, on an options page the current option.
  useEffect(() => {
    menuRow.current
      ?.querySelector<HTMLElement>('[data-focus="true"]')
      ?.focus({ preventScroll: true })
  }, [page])

  const visible = shown || blocked
  const onPicture = (e: { target: unknown }) =>
    !bar.current?.contains(e.target as Node)
  return (
    <div
      ref={root}
      className="player"
      data-idle={!visible}
      tabIndex={-1}
      onPointerMove={(e) => e.pointerType === 'mouse' && ui.poke()}
      onPointerDown={(e) => {
        pointer.current = e.pointerType
        const t = e.target as Element
        if (!menuRow.current?.contains(t) && !qBtn.current?.contains(t))
          setPage(null) // a click outside closes the popover
        // Touch: a tap on the picture toggles the bar (a hidden bar ignores
        // touches, see Player.css); mouse/pointer just shows it.
        if (e.pointerType === 'mouse' || !onPicture(e)) ui.poke()
        else if (visible) ui.hide()
        else ui.poke()
      }}
      // A double click also toggles twice (net: unchanged), like most players.
      onClick={(e) =>
        pointer.current === 'mouse' && onPicture(e) && ui.toggle()
      }
      onDoubleClick={(e) => onPicture(e) && ui.fullscreen()}
    >
      {children}
      <div
        ref={bar}
        className="bar"
        data-shown={visible}
        // Clicks don't focus buttons, so ←/→ keep seeking after a click.
        onMouseDown={(e) =>
          (e.target as Element).closest('button') && e.preventDefault()
        }
      >
        <div data-row className="row">
          <input
            type="range"
            data-seek="1"
            aria-label="Seek"
            min={0}
            max={duration || 0}
            step={1}
            value={Math.min(time, duration || 0)}
            onChange={(e) => {
              setTime(seekTo(video.current!, Number(e.target.value)))
            }}
          />
          <span className="time">
            {clock(time)} / {clock(duration)}
          </span>
        </div>
        {page === 'main' && (
          <div
            ref={menuRow}
            className="popover"
            data-page="main"
            role="menu"
            aria-label="Settings"
          >
            {settings.map((st, i) => (
              <button
                key={st.name}
                type="button"
                role="menuitem"
                data-focus={i === from}
                onClick={() => {
                  setFrom(i)
                  setPage(i)
                }}
              >
                {st.name}
                <small>
                  {st.options.find((o) => o.value === st.value)?.label}
                  {st.status && ` · ${st.status}`} ›
                </small>
              </button>
            ))}
          </div>
        )}
        {typeof page === 'number' && settings[page] && (
          <div
            ref={menuRow}
            className="popover"
            role="menu"
            aria-label={settings[page].name}
          >
            <button
              type="button"
              role="menuitem"
              className="heading"
              onClick={() => setPage('main')}
            >
              ‹ {settings[page].name}
            </button>
            {settings[page].options.map((o) => {
              const st = settings[page]
              const on = o.value === st.value
              return (
                <button
                  key={o.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  data-focus={on}
                  disabled={o.disabled}
                  onClick={() => {
                    setPage(null)
                    qBtn.current?.focus({ preventScroll: true })
                    if (!on) st.pick(o.value)
                  }}
                >
                  <span className="check">{on ? '✓' : ''}</span>
                  {o.label}
                  {o.hint && <small>{o.hint}</small>}
                </button>
              )
            })}
          </div>
        )}
        <div data-row className="row">
          <button
            ref={play}
            type="button"
            aria-label={paused ? 'Play' : 'Pause'}
            onClick={ui.toggle}
          >
            <Icon d={paused ? ICON.play : ICON.pause} />
          </button>
          <button
            type="button"
            aria-label="Rewind 10 seconds"
            onClick={() => ui.seek(-SKIP)}
          >
            −10
          </button>
          <button
            type="button"
            aria-label="Forward 10 seconds"
            onClick={() => ui.seek(SKIP)}
          >
            +10
          </button>
          <button
            type="button"
            aria-label={muted ? 'Unmute' : 'Mute'}
            onClick={ui.mute}
          >
            <Icon d={muted || volume === 0 ? ICON.muted : ICON.sound} />
          </button>
          <input
            type="range"
            data-volume="1"
            aria-label="Volume"
            className="volume"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => setVol(video.current!, Number(e.target.value))}
          />
          <span className="spacer" />
          <button
            ref={qBtn}
            type="button"
            aria-label="Playback options"
            aria-haspopup="menu"
            aria-expanded={page !== null}
            onClick={() => setPage(page === null ? 'main' : null)}
          >
            <Icon d={ICON.gear} />
          </button>
          <button
            type="button"
            aria-label={full ? 'Exit fullscreen' : 'Fullscreen'}
            onClick={ui.fullscreen}
          >
            <Icon d={full ? ICON.unfull : ICON.full} />
          </button>
        </div>
      </div>
    </div>
  )
}
