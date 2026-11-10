// Per-device user settings (#113), in localStorage: per device by design (no
// account sync until #92, nothing goes to the API). try/catch: storage can
// throw (private mode, blocked site data); missing/invalid = the default.
// Read at playback start, so a change applies from the next playback.
const KEY = 'streamiq.settings.compatible'

/** Compatible mode: the most restrictive device profile (profile.ts). */
export function compatibleOn() {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function setCompatible(on: boolean) {
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch {
    /* not saved: stays the default */
  }
}
