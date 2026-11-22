import { auth } from './firebase'
import { clearArtThen } from './leave'
import { AppError, httpError } from './errors'
import { noop } from './noop'
import type { Me } from '../generated/me'
import type { Created, Named } from '../generated/household'

// Prod: the API serves this bundle, so same origin. Dev: vite :5173, API :5028.
// Every endpoint lives under /api (the rest of the path space is client routes).
export const API =
  (import.meta.env.VITE_API_URL ??
    (import.meta.env.DEV ? 'http://localhost:5028' : location.origin)) + '/api'

// The household (code: tenant) requests act in, per device and user: set by the
// switcher or when the user joins one, else unset and the API uses the
// user's oldest. A household the user isn't in (anymore) answers a 404 marked
// X-StreamIQ-Not-Member: authed() clears it.
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
  clearArtThen(() =>
    location.pathname === '/join' ? location.reload() : location.replace('/'),
  ) // the lost household's artwork goes too
  return new Promise(noop) // ponytail: the page is going away; callers never settle
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
  if (res.status === 404 && res.headers.has('X-StreamIQ-Not-Member'))
    // No household at all: Shell shows the no-household screen once /me
    // is in, in place of the page that asked. ponytail: never settles, like lostHousehold.
    return h ? lostHousehold(h) : new Promise<never>(noop)
  if (!res.ok) throw httpError('api', res.status, path)
  return (res.status === 204 ? null : res.json()) as Promise<T>
}

export type { Me }
// Any signed-in user: a new household with them as its admin.
export const createHousehold = () =>
  authed<Created>('/households', { method: 'POST' })
// Admin only; the stored (trimmed) name comes back. loaded keeps it too,
// for a later "no longer a member of …" notice.
export const renameHousehold = (name: string) =>
  authed<Named>('/households/current/name', {
    method: 'PUT',
    body: JSON.stringify({ name }),
  }).then((r) => {
    const m = loaded?.memberships.find((x) => x.id === loaded?.tenantId)
    if (m) m.name = r.name
    return r.name
  })
// Shell calls it once per sign-in: forget the previous user's household first (sign
// out + in again doesn't reload the page).
export function getMe() {
  loaded = null
  return authed<Me>('/me').then((me) => (loaded = me))
}
