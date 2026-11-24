// Per-device user settings, in localStorage: per device by design (no
// account sync, nothing goes to the API). try/catch: storage can
// throw (private mode, blocked site data); missing/invalid = the default.
// Read at playback start, so a change applies from the next playback.
import {
  saverOn,
  toQuality,
  type Quality,
  type SaverMode,
} from '../features/player/profile'
import { guessTv } from '../features/tv/tv'
import { DEFAULT_EVERY, toEvery, type Every } from './speedPolicy'

const KEY = 'streamiq.settings.compatible'
const RAW_KEY = 'streamiq.settings.raw'
const QUALITY_KEY = 'streamiq.settings.quality'

function flag(key: string) {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function setFlag(key: string, on: boolean) {
  try {
    if (on) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  } catch {
    /* not saved: stays the default */
  }
}

/** Compatible mode: the most restrictive device profile (profile.ts). */
export const compatibleOn = () => flag(KEY)
export const setCompatible = (on: boolean) => setFlag(KEY, on)

/** The Raw quality option: original streams, no capability probe. */
export const rawOn = () => flag(RAW_KEY)
export const setRaw = (on: boolean) => setFlag(RAW_KEY, on)

/** The player's quality picker; applies at once (the player reloads).
 * A stored Raw without its setting, or Source/Raw in compatible mode, plays
 * as Auto; the stored choice is kept for when that changes. */
export function quality(): Quality {
  let q: Quality = 'Auto'
  try {
    q = toQuality(localStorage.getItem(QUALITY_KEY))
  } catch {
    /* unreadable: Auto */
  }
  if (q === 'Raw' && !rawOn()) return 'Auto'
  if ((q === 'Source' || q === 'Raw') && compatibleOn()) return 'Auto'
  return q
}

export function setQuality(q: Quality) {
  try {
    localStorage.setItem(QUALITY_KEY, q)
  } catch {
    /* not saved: this playback only */
  }
}

/** Data saver: Automatic (unset) / On / Off. Read on every
 * measurement and playback start. */
const SAVER_KEY = 'streamiq.settings.dataSaver'
export function dataSaver(): SaverMode {
  try {
    const v = localStorage.getItem(SAVER_KEY)
    return v === 'on' || v === 'off' ? v : 'auto'
  } catch {
    return 'auto'
  }
}
export function setDataSaver(mode: SaverMode) {
  try {
    if (mode === 'auto') localStorage.removeItem(SAVER_KEY)
    else localStorage.setItem(SAVER_KEY, mode)
  } catch {
    /* not saved: stays Automatic */
  }
}
/** The browser's network hint (Network Information API; Chromium only). */
export const netInfo = () =>
  (
    navigator as Navigator & {
      connection?: { saveData?: boolean; type?: string }
    }
  ).connection
export const dataSaverOn = () => saverOn(dataSaver(), netInfo())

/** "Measure connection speed": how long a reading is used before Auto
 * playback measures again, or Off (only /diagnostics measures). */
const SPEED_KEY = 'streamiq.settings.speedEvery'
export function speedEvery(): Every {
  try {
    return toEvery(localStorage.getItem(SPEED_KEY))
  } catch {
    return DEFAULT_EVERY
  }
}
export function setSpeedEvery(v: Every) {
  try {
    if (v === DEFAULT_EVERY) localStorage.removeItem(SPEED_KEY)
    else localStorage.setItem(SPEED_KEY, v)
  } catch {
    /* not saved: the previous choice stays */
  }
}

/** TV mode: larger root size + 5 % safe-area padding (index.css
 * `html.tv`). Stored '1' / '0'; unset = first visit, where the TV guess
 * (tv.ts) picks the default: a known TV stores on, an unsure one asks. */
const TV_KEY = 'streamiq.settings.tv'
function tvStored() {
  try {
    return localStorage.getItem(TV_KEY)
  } catch {
    return '0' // unreadable: off, and never ask
  }
}
export const tvOn = () => tvStored() === '1'
export function setTv(on: boolean) {
  try {
    localStorage.setItem(TV_KEY, on ? '1' : '0')
  } catch {
    /* not saved: this page view only */
  }
  document.documentElement.classList.toggle('tv', on)
  dispatchEvent(new Event(TV_EVENT))
}
/** Fired on window when setTv changes TV mode (the shell re-reads tvOn). */
export const TV_EVENT = 'streamiq:tv'
const guess = () => guessTv(navigator.userAgent, navigator.maxTouchPoints)
/** First visit on an Android box that may be a TV: ask once. */
export const askTv = () => tvStored() === null && guess() === 'unsure'
export function applyTv() {
  if (tvStored() === null && guess() === 'tv') setTv(true)
  else document.documentElement.classList.toggle('tv', tvOn())
}

/** The last opened gateway: the active one outside its routes (shell.ts). */
const LAST_GATEWAY_KEY = 'streamiq.lastGateway'
export function lastGateway() {
  try {
    return localStorage.getItem(LAST_GATEWAY_KEY)
  } catch {
    return null
  }
}
export function setLastGateway(id: string) {
  if (id === lastGateway()) return
  try {
    localStorage.setItem(LAST_GATEWAY_KEY, id)
  } catch {
    /* not saved: the active gateway falls back to the first online one */
  }
  dispatchEvent(new Event(LAST_GATEWAY_EVENT))
}
const LAST_GATEWAY_EVENT = 'streamiq:lastGateway'
/** useSyncExternalStore's subscribe for lastGateway (Switch changes it). */
export function onLastGateway(cb: () => void) {
  addEventListener(LAST_GATEWAY_EVENT, cb)
  return () => removeEventListener(LAST_GATEWAY_EVENT, cb)
}
