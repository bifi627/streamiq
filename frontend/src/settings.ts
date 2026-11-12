// Per-device user settings (#113), in localStorage: per device by design (no
// account sync until #92, nothing goes to the API). try/catch: storage can
// throw (private mode, blocked site data); missing/invalid = the default.
// Read at playback start, so a change applies from the next playback.
import { toQuality, type Quality } from './features/library/profile'

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

/** The Raw quality option (#164): original streams, no capability probe. */
export const rawOn = () => flag(RAW_KEY)
export const setRaw = (on: boolean) => setFlag(RAW_KEY, on)

/** The player's quality picker (#108); applies at once (the player reloads).
 * A stored Raw without its setting, or Source/Raw in compatible mode, plays
 * as Auto (#164); the stored choice is kept for when that changes. */
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
