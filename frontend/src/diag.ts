// On-page connection diagnostics for devices without devtools (TVs, phones).
// Always recorded (cheap ring buffers); the panel only shows when enabled via
// the Settings checkbox or `?debug`. Toggles live in localStorage
// because a TV can't edit the URL.

export type Req = {
  path: string
  t0: number
  ms?: number
  opened: boolean
  result?: string // "HTTP 200" | error text; unset while in flight
}

export const diag = {
  reqs: [] as Req[],
  events: [] as string[],
  pc: '', // "connection / ice" of the current session
  media: '', // <video> state while the player is open
  sb: '', // hls.js per-SourceBuffer ranges + fragment counters
  frames: '', // dropped/total video frames while the player is open
  cpu: '', // sampler (#293), only while diagnostics is on
  memory: '', // Chromium only
  lastRun: '', // "last run ended without closing the page: …"
  inFlight: 0,
  peak: 0,
}

let version = 0
const subs = new Set<() => void>()
export function changed() {
  version++
  subs.forEach((f) => f())
}
export const subscribe = (f: () => void) => {
  subs.add(f)
  return () => void subs.delete(f)
}
export const snapshot = () => version

const push = <T>(a: T[], x: T, max: number) => {
  a.push(x)
  if (a.length > max) a.shift()
}

export function event(msg: string) {
  push(diag.events, `${new Date().toLocaleTimeString()} ${msg}`, 50)
  changed()
}

export function pcState(pc: RTCPeerConnection) {
  diag.pc = `${pc.connectionState} / ${pc.iceConnectionState}`
  event(`pc ${diag.pc}`)
}

export const ranges = (r: TimeRanges) =>
  Array.from(
    { length: r.length },
    (_, i) => `${r.start(i).toFixed(1)}-${r.end(i).toFixed(1)}`,
  ).join(' ') || 'none'

/** Logs a <video>'s events and keeps diag.media current; returns the stop function. */
export function watchVideo(v: HTMLVideoElement) {
  const names = [
    'loadedmetadata',
    'canplay',
    'play',
    'playing',
    'pause',
    'waiting',
    'stalled',
    'seeking',
    'seeked',
    'error',
  ]
  const on = (e: Event) =>
    event(
      `video ${e.type}${v.error ? ` (code ${v.error.code} ${v.error.message})` : ''} @${v.currentTime.toFixed(1)}`,
    )
  names.forEach((n) => v.addEventListener(n, on))
  const t = setInterval(() => {
    // The decoder runs off the main thread: dropped frames are how its strain shows.
    const q = v.getVideoPlaybackQuality?.()
    diag.frames = q
      ? `${q.droppedVideoFrames}/${q.totalVideoFrames} dropped`
      : ''
    diag.media = `t=${v.currentTime.toFixed(1)} ready=${v.readyState} paused=${v.paused} ${v.videoWidth}x${v.videoHeight} muted=${v.muted} vol=${v.volume} buffered=${ranges(v.buffered)}${diag.frames && ` frames=${diag.frames}`}`
    changed()
  }, 1000)
  return () => {
    names.forEach((n) => v.removeEventListener(n, on))
    clearInterval(t)
    diag.media = ''
    diag.frames = ''
    diag.sb = ''
    changed()
  }
}

/** Tracks one tunnel request; call the returned functions as it progresses. */
export function request(url: string) {
  const r: Req = {
    path: url.split('?')[0],
    t0: performance.now(),
    opened: false,
  }
  push(diag.reqs, r, 20)
  diag.inFlight++
  diag.peak = Math.max(diag.peak, diag.inFlight)
  changed()
  return {
    opened() {
      r.opened = true
      changed()
    },
    done(result: string) {
      if (r.result !== undefined) return
      r.result = result
      r.ms = Math.round(performance.now() - r.t0)
      diag.inFlight--
      changed()
    },
  }
}

// Flags. try/catch: storage can throw (private mode, blocked site data).
function flag(name: string) {
  try {
    return localStorage.getItem(`streamiq.${name}`) === '1'
  } catch {
    return false
  }
}
export function setFlag(name: string, on: boolean) {
  try {
    if (on) localStorage.setItem(`streamiq.${name}`, '1')
    else localStorage.removeItem(`streamiq.${name}`)
  } catch {
    /* ignore */
  }
  if (name === 'debug') {
    if (debugOn()) startSampler()
    else stop?.()
  }
  changed()
}
const q = () => new URLSearchParams(location.search)
export const debugOn = () => q().has('debug') || flag('debug')
export const relayOn = () => q().has('relay') || flag('relay')
/** ?fail=<n>: the first n player loads look stuck (forces the #238 escalation). */
export const failLoads = () => Number(q().get('fail')) || 0
/** Seconds a playback must really play before it saves anything (#330);
 * localStorage `streamiq.watchMin` overrides it (e2e: 0). */
export function watchMin() {
  try {
    const s = localStorage.getItem('streamiq.watchMin')
    if (s !== null) return Number(s)
  } catch {
    /* ignore */
  }
  return 60
}

// Errors nobody caught would otherwise vanish on a TV.
addEventListener('error', (e) => event(`error: ${e.message}`))
addEventListener('unhandledrejection', (e) =>
  event(
    `unhandled: ${e.reason instanceof Error ? e.reason.message : e.reason}`,
  ),
)

// CPU + memory sampler (#293), only while diagnostics is on. A web page can't see
// a TV's temperature or power-off, but it can see main-thread load and, at the next
// start, that the last run never closed the page (power-off, tab killed for memory).
const TICK = 2000
const LAST = 'streamiq.lastSample'
type Mem = { usedJSHeapSize: number; jsHeapSizeLimit: number }
const mem = () => (performance as { memory?: Mem }).memory // Chromium only
const mb = (b: number) => Math.round(b / 2 ** 20)
const dropLast = () => {
  try {
    localStorage.removeItem(LAST)
  } catch {
    /* ignore */
  }
}
let stop: (() => void) | undefined
const heap0 = mem()?.usedJSHeapSize ?? 0 // page load, even if the sampler starts later

function startSampler() {
  if (stop) return
  let prev = performance.now()
  let maxLag = 0
  let busy = 0 // ms of long tasks since the last tick
  let high = false // heap above 80% of its limit
  // observe() only warns on an unknown type, so check first (unsupported: no busy %)
  const obs = PerformanceObserver.supportedEntryTypes?.includes('longtask')
    ? new PerformanceObserver((l) =>
        l.getEntries().forEach((e) => (busy += e.duration)),
      )
    : undefined
  obs?.observe({ type: 'longtask' })
  const t = setInterval(() => {
    const now = performance.now()
    // Hidden pages get throttled timers: that's not load.
    const lag = document.hidden ? 0 : Math.max(0, Math.round(now - prev - TICK))
    const pct = Math.min(100, Math.round((busy / (now - prev)) * 100))
    prev = now
    busy = 0
    maxLag = Math.max(maxLag, lag)
    if (lag > 500) event(`cpu: lag spike ${lag} ms`)
    diag.cpu = `lag ${lag} ms (max ${maxLag}) · busy ${obs ? `${pct}%` : 'n/a'} · cores ${navigator.hardwareConcurrency ?? '?'}`
    const m = mem()
    if (m) {
      const dev = (navigator as { deviceMemory?: number }).deviceMemory
      const growth = mb(m.usedJSHeapSize - heap0)
      diag.memory = `heap ${mb(m.usedJSHeapSize)}/${mb(m.jsHeapSizeLimit)} MB (${growth < 0 ? '' : '+'}${growth} since load) · device ${dev ?? '?'} GB`
      const over = m.usedJSHeapSize > 0.8 * m.jsHeapSizeLimit
      if (over && !high) event(`memory: heap above 80% (${diag.memory})`)
      high = over
    }
    try {
      localStorage.setItem(
        LAST,
        [
          new Date().toLocaleString(),
          `cpu: ${diag.cpu}`,
          diag.memory && `memory: ${diag.memory}`,
          diag.frames && `frames: ${diag.frames}`,
        ]
          .filter(Boolean)
          .join(' · '),
      )
    } catch {
      /* ignore */
    }
    changed()
  }, TICK)
  // Closing or reloading the page fires pagehide; a power-off or a killed tab doesn't.
  addEventListener('pagehide', dropLast)
  stop = () => {
    clearInterval(t)
    obs?.disconnect()
    removeEventListener('pagehide', dropLast)
    dropLast()
    diag.cpu = diag.memory = ''
    stop = undefined
  }
}

try {
  const s = localStorage.getItem(LAST)
  if (s) {
    diag.lastRun = `last run ended without closing the page: ${s}`
    event(diag.lastRun)
    localStorage.removeItem(LAST) // shown once; a running sampler writes a new one
  }
} catch {
  /* ignore */
}
if (globalThis.location && debugOn()) startSampler() // no location in unit tests
