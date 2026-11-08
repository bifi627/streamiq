// On-page connection diagnostics for devices without devtools (TVs, phones).
// Always recorded (cheap ring buffers); the panel only shows when enabled via
// the header's Diagnostics button or `?debug`. Toggles live in localStorage
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
  push(diag.events, `${new Date().toLocaleTimeString()} ${msg}`, 30)
  changed()
}

export function pcState(pc: RTCPeerConnection) {
  diag.pc = `${pc.connectionState} / ${pc.iceConnectionState}`
  event(`pc ${diag.pc}`)
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
  changed()
}
const q = () => new URLSearchParams(location.search)
export const debugOn = () => q().has('debug') || flag('debug')
export const relayOn = () => q().has('relay') || flag('relay')

// Errors nobody caught would otherwise vanish on a TV.
addEventListener('error', (e) => event(`error: ${e.message}`))
addEventListener('unhandledrejection', (e) =>
  event(
    `unhandled: ${e.reason instanceof Error ? e.reason.message : e.reason}`,
  ),
)
