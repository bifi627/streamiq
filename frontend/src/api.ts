import { auth } from './firebase'
import { AppError, httpError } from './errors'

// Prod: the API serves this bundle, so same origin. Dev: vite :5173, API :5028.
// Every endpoint lives under /api (the rest of the path space is client routes).
export const API =
  (import.meta.env.VITE_API_URL ??
    (import.meta.env.DEV ? 'http://localhost:5028' : location.origin)) + '/api'

// The household (code: tenant) requests act in, per device and user: set when the
// user joins one (#191), else unset and the API uses the user's oldest. ponytail: no
// switcher yet (#193); a household the user left answers 404 (Shell clears it).
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

export async function authed<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await auth.currentUser?.getIdToken()
  const h = household()
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
  if (!res.ok) throw httpError('api', res.status, path)
  return (res.status === 204 ? null : res.json()) as Promise<T>
}

// A household (code: tenant) the user belongs to.
export type Membership = {
  id: string
  name: string | null
  role: 'admin' | 'member'
}
export const getMe = () =>
  authed<{ userId: string; tenantId: string; memberships: Membership[] }>('/me')
