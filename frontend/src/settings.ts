// Per-device user settings (#113), in localStorage: per device by design (no
// account sync until #92, nothing goes to the API). try/catch: storage can
// throw (private mode, blocked site data); missing/invalid = the default.
// Read at playback start, so a change applies from the next playback.
import {
  saverOn,
  toQuality,
  type Quality,
  type SaverMode,
} from './features/library/profile'

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

/** Data saver (#291): Automatic (unset) / On / Off. Read on every
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
export const dataSaverOn = () =>
  saverOn(
    dataSaver(),
    (
      navigator as Navigator & {
        connection?: { saveData?: boolean; type?: string }
      }
    ).connection,
  )

/** TV mode (#201): larger root size + 5 % safe-area padding (index.css
 * `html.tv`). Manual only, no TV detection. */
const TV_KEY = 'streamiq.settings.tv'
export const tvOn = () => flag(TV_KEY)
export function setTv(on: boolean) {
  setFlag(TV_KEY, on)
  applyTv()
}
export const applyTv = () =>
  document.documentElement.classList.toggle('tv', tvOn())

/** The last opened gateway (#201): the nav's Library link outside its routes. */
const LAST_GATEWAY_KEY = 'streamiq.lastGateway'
export function lastGateway() {
  try {
    return localStorage.getItem(LAST_GATEWAY_KEY)
  } catch {
    return null
  }
}
export function setLastGateway(id: string) {
  try {
    localStorage.setItem(LAST_GATEWAY_KEY, id)
  } catch {
    /* not saved: the link shows with one gateway only */
  }
}
