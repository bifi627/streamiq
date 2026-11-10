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

const isBack = (e: KeyboardEvent) =>
  e.key === 'Escape' ||
  e.key === 'GoBack' ||
  e.key === 'BrowserBack' ||
  e.keyCode === 461 // webOS remote

export function Controls({
  video,
  duration,
  blocked,
  onBack,
  subtitles,
  children,
}: {
  video: RefObject<HTMLVideoElement | null>
  duration: number
  blocked: boolean
  onBack: () => void
  subtitles: ReactNode
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
      setTime(v.currentTime)
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
      if (isBack(e)) {
        e.preventDefault() // the browser's own Back would leave the player too
        if (inBar || bar.current?.dataset.shown === 'true') ui.hide()
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
        Array.from(r.querySelectorAll<HTMLElement>('button, input, select'))
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
          {subtitles}
          <span className="spacer" />
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
