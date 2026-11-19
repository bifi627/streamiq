// Own control bar over <video> (#91): one UI for TV remote (D-pad), touch,
// mouse and keyboard. Key model (decided in keyAction(), keys.ts; onKey(),
// handlers.ts, only reads the DOM and runs the result):
// - Focus outside the bar (bar hidden, or shown by a pointer/seek key):
//   ←/→ seek ±10 s, Enter/Space play-pause, ↑/↓ focus play/pause.
// - Focus inside the bar: ←/→ move focus within a row (on the seek bar: seek),
//   ↑/↓ switch rows (on volume: ±10 %; down from the last row: the
//   diagnostics dock, if it's on).
// - Back (Escape, webOS 461/GoBack): in the popover goes up one page, then
//   closes it; else hides the bar if shown, else exits.
// - With Ctrl, Cmd or Alt held a key is the browser's (Ctrl+F find, …); held
//   down, a toggle (F, M, K, Enter/Space) fires once, arrows repeat (#549).
// - F fullscreen, M mute, K play-pause, anywhere (the popover too). Any key /
//   mouse move shows the bar; it hides after HIDE_MS (playing or paused; it
//   stays only while autoplay is blocked).
// - Mouse (and Magic Remote pointer) on the picture: click play-pause, double
//   click fullscreen. Touch: tap toggles the bar.
// - Settings (#108, #153): the gear opens a popover over the picture: a main
//   page with one row per setting (name + current value), each opening its
//   options page. ↑/↓ move, Enter opens / picks (and closes), Back goes up one
//   page, then closes. A click outside closes it. One button for every setting,
//   so the bar stays one row on a phone and the remote model stays ↑/↓ + Enter.
// - Overlay (#205): the bar covers the picture (clicks pass through its gaps);
//   its top row (Back, title, `top`: the privacy badge) is one more row for
//   ↑/↓, after the button row. `onNext` adds "Next episode" before the gear.
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { summary, tap } from './bar'
import {
  loadVol,
  makeUi,
  onKey,
  saveVol,
  seekTo,
  setVol,
  type Page,
  type Refs,
  type Ui,
} from './handlers'
import { clock } from './items'
import { SKIP } from './keys'
import './Player.css'

// Material icon paths (24×24); the remote and Play on… use them too.
export const ICON = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  sound:
    'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  muted:
    'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  full: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
  stop: 'M6 6h12v12H6z',
  cast: 'M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z',
  tv: 'M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z',
  back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
  unfull:
    'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
}
export const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d={d} />
  </svg>
)

/** A slider's filled part (Player.css paints it; Chrome 87: no accent-color). */
const fill = (x: number) =>
  ({ '--p': `${Math.min(1, Math.max(0, x)) * 100}%` }) as CSSProperties

/** One entry of the settings menu (quality, later audio #109, subtitles #136). */
export type Setting = {
  name: string
  value: string
  options: { value: string; label: string; hint?: string; disabled?: boolean }[]
  /** What is in effect, shown next to the value (e.g. "Original 4K"). */
  status?: string
  pick: (value: string) => void
}

/** The <video>'s state for the bar, kept in sync by its events; loads and
 *  saves the volume. `onPlay` restarts the hide countdown. */
function useMedia(
  video: RefObject<HTMLVideoElement | null>,
  setTime: (t: number) => void,
  onPlay: () => void,
) {
  const [paused, setPaused] = useState(true)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(0.5)
  const [full, setFull] = useState(false)
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
      onPlay()
    }
    const fs = () => setFull(!!document.fullscreenElement)
    const evs = ['pause', 'timeupdate', 'volumechange', 'seeked'] as const
    loadVol(v)
    sync() // no volumechange when the stored level is the element's own (1)
    evs.forEach((e) => v.addEventListener(e, sync))
    const save = () => saveVol(v)
    v.addEventListener('volumechange', save)
    v.addEventListener('play', playing)
    document.addEventListener('fullscreenchange', fs)
    return () => {
      evs.forEach((e) => v.removeEventListener(e, sync))
      v.removeEventListener('volumechange', save)
      v.removeEventListener('play', playing)
      document.removeEventListener('fullscreenchange', fs)
    }
  }, [video, setTime, onPlay])
  return { paused, muted, volume, full }
}

/** The seek bar and the clock. */
function Seek({
  time,
  duration,
  onSeek,
}: {
  time: number
  duration: number
  onSeek: (t: number) => void
}) {
  return (
    <div data-row className="row">
      <input
        type="range"
        data-seek="1"
        aria-label="Seek"
        min={0}
        max={duration || 0}
        step={1}
        value={Math.min(time, duration || 0)}
        style={fill(duration ? time / duration : 0)}
        onChange={(e) => onSeek(Number(e.target.value))}
      />
      <span className="time">
        {clock(time)} / {clock(duration)}
      </span>
    </div>
  )
}

/** The popover: the main page (one row per setting) or one setting's options. */
function Menu({
  settings,
  page,
  from,
  menuRow,
  open,
  close,
}: {
  settings: Setting[]
  page: Page
  /** The setting whose page was open last: the main page focuses it. */
  from: number
  menuRow: RefObject<HTMLDivElement | null>
  open: (p: 'main' | number) => void
  close: () => void
}) {
  if (page === 'main')
    return (
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
            onClick={() => open(i)}
          >
            {st.name}
            <small>{summary(st)}</small>
          </button>
        ))}
      </div>
    )
  const st = page === null ? undefined : settings[page]
  if (!st) return null
  return (
    <div ref={menuRow} className="popover" role="menu" aria-label={st.name}>
      <button
        type="button"
        role="menuitem"
        className="heading"
        onClick={() => open('main')}
      >
        ‹ {st.name}
      </button>
      {st.options.map((o) => {
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
              close()
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
  )
}

/** The button row: play, ±10 s, volume, Next episode, settings, fullscreen. */
function Buttons({
  media,
  ui,
  play,
  qBtn,
  menuOpen,
  onGear,
  onVolume,
  onNext,
}: {
  media: ReturnType<typeof useMedia>
  ui: Ui
  play: RefObject<HTMLButtonElement | null>
  qBtn: RefObject<HTMLButtonElement | null>
  menuOpen: boolean
  onGear: () => void
  onVolume: (x: number) => void
  onNext?: () => void
}) {
  const { paused, muted, volume, full } = media
  return (
    <div data-row className="row">
      <button
        ref={play}
        type="button"
        className="play"
        aria-label={paused ? 'Play' : 'Pause'}
        onClick={ui.toggle}
      >
        <Icon d={paused ? ICON.play : ICON.pause} />
      </button>
      <button
        type="button"
        className="skip"
        aria-label="Rewind 10 seconds"
        onClick={() => ui.seek(-SKIP)}
      >
        −10
      </button>
      <button
        type="button"
        className="skip"
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
        style={fill(muted ? 0 : volume)}
        onChange={(e) => onVolume(Number(e.target.value))}
      />
      <span className="spacer" />
      {onNext && (
        <button
          type="button"
          className="next"
          aria-label="Next episode"
          onClick={onNext}
        >
          <Icon d={ICON.next} />
          <span>Next episode</span>
        </button>
      )}
      <button
        ref={qBtn}
        type="button"
        aria-label="Playback options"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={onGear}
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
  )
}

export function Controls({
  video,
  duration,
  blocked,
  settings,
  onBack,
  onNext,
  top,
  children,
}: {
  video: RefObject<HTMLVideoElement | null>
  duration: number
  blocked: boolean
  settings: Setting[]
  onBack: () => void
  onNext?: () => void
  /** The overlay's top row after Back: title, privacy badge. */
  top?: ReactNode
  children: ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const play = useRef<HTMLButtonElement>(null)
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
  const [shown, setShown] = useState(true)
  const [page, setPage] = useState<Page>(null)
  const [from, setFrom] = useState(0) // setting whose page was open last
  const [time, setTime] = useState(0)
  const [r] = useState<Refs>(() => ({
    video,
    root,
    bar,
    play,
    menuRow,
    qBtn,
    timer,
    back,
    dur,
    blocked: isBlocked,
  }))
  const [ui] = useState(() => makeUi(r, setShown, setPage, setTime))
  const media = useMedia(video, setTime, ui.poke)

  useEffect(() => {
    const v = video.current!
    const key = (e: KeyboardEvent) => onKey(e, v, r, ui, setPage)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('keydown', key)
      ui.stop()
    }
  }, [video, r, ui])

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
        ui[tap(e.pointerType === 'mouse', onPicture(e), visible)]()
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
        <div data-row className="row top">
          <button
            type="button"
            aria-label="Back"
            onClick={() => back.current()}
          >
            <Icon d={ICON.back} />
          </button>
          {top}
        </div>
        <span className="spacer" />
        <div className="bottom">
          <Seek
            time={time}
            duration={duration}
            onSeek={(t) => setTime(seekTo(video.current!, t))}
          />
          <Menu
            settings={settings}
            page={page}
            from={from}
            menuRow={menuRow}
            open={(p) => {
              if (p !== 'main') setFrom(p)
              setPage(p)
            }}
            close={ui.close}
          />
          <Buttons
            media={media}
            ui={ui}
            play={play}
            qBtn={qBtn}
            menuOpen={page !== null}
            onGear={() => setPage(page === null ? 'main' : null)}
            onVolume={(x) => setVol(video.current!, x)}
            onNext={onNext}
          />
        </div>
      </div>
    </div>
  )
}
