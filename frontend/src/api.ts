import { auth } from './firebase'
import { AppError, httpError } from './errors'

// Prod: the API serves this bundle, so same origin. Dev: vite :5173, API :5028.
// Every endpoint lives under /api (the rest of the path space is client routes).
export const API =
  (import.meta.env.VITE_API_URL ??
    (import.meta.env.DEV ? 'http://localhost:5028' : location.origin)) + '/api'

// The household (code: tenant) requests act in, per device and user: set by the
// switcher (#193) or when the user joins one (#191), else unset and the API uses the
// user's oldest. A household the user isn't in (anymore) answers a 404 marked
// X-StreamIQ-Not-Member: authed() clears it (#210).
const householdKey = () => `streamiq.household.${auth.currentUser?.uid}`
export function household() {
  try {
    return localStorage.getItem(householdKey())
  } catch {
    return null
  }
}
export function setHousehold(id: string | null) {
  try {
    if (id) localStorage.setItem(householdKey(), id)
    else localStorage.removeItem(householdKey())
  } catch {
    /* not saved: the API uses the oldest household */
  }
}

// This page load's /me. Once it's in, every request names its household, even the
// default one: losing it (removed by an admin, left in another tab) is then a
// not-a-member 404, never a silent switch to the next-oldest household.
let loaded: Me | null = null

// Unnamed households (no rename yet) are told apart by the end of their id (the
// start is a UUIDv7 timestamp, alike for households made close together).
export const householdLabel = (m: { id: string; name: string | null }) =>
  m.name ?? `Household …${m.id.slice(-6)}`

// Shell shows it once after the reload (per tab).
const noticeKey = 'streamiq.notice'
export function takeNotice() {
  try {
    const n = sessionStorage.getItem(noticeKey)
    sessionStorage.removeItem(noticeKey)
    return n
  } catch {
    return null
  }
}

// Not a member of the household this tab acts in: drop the choice and reload into
// the default household with a notice. Home, since the current page belongs to the
// lost household; a /join link stays (its token names the household to join).
function lostHousehold(id: string): Promise<never> {
  const m = loaded?.memberships.find((x) => x.id === id) ?? { id, name: null }
  try {
    sessionStorage.setItem(
      noticeKey,
      `You're no longer a member of ${householdLabel(m)}.`,
    )
  } catch {
    /* no notice: the reload still lands on the default household */
  }
  setHousehold(null)
  if (location.pathname === '/join') location.reload()
  else location.replace('/')
  return new Promise(() => {}) // ponytail: the page is going away; callers never settle
}

export async function authed<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await auth.currentUser?.getIdToken()
  const h = loaded?.tenantId ?? household()
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init?.body !== undefined && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(h && { 'X-StreamIQ-Household': h }),
    },
  }).catch((e: Error) => {
    throw new AppError('network', `${path}: ${e.message}`)
  })
  if (res.status === 404 && h && res.headers.has('X-StreamIQ-Not-Member'))
    return lostHousehold(h)
  if (!res.ok) throw httpError('api', res.status, path)
  return (res.status === 204 ? null : res.json()) as Promise<T>
}

// A household (code: tenant) the user belongs to.
export type Membership = {
  id: string
  name: string | null
  role: 'admin' | 'member'
}
export type Me = { userId: string; tenantId: string; memberships: Membership[] }
// Shell calls it once per sign-in: forget the previous user's household first (sign
// out + in again doesn't reload the page).
export function getMe() {
  loaded = null
  return authed<Me>('/me').then((me) => (loaded = me))
}
