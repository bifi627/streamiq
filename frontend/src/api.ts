import { auth } from './firebase'
import { AppError, httpError } from './errors'

// Prod: the API serves this bundle, so same origin. Dev: vite :5173, API :5028.
// Every endpoint lives under /api (the rest of the path space is client routes).
export const API =
  (import.meta.env.VITE_API_URL ??
    (import.meta.env.DEV ? 'http://localhost:5028' : location.origin)) + '/api'

export async function authed<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await auth.currentUser?.getIdToken()
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init?.body !== undefined && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
  }).catch((e: Error) => {
    throw new AppError('network', `${path}: ${e.message}`)
  })
  if (!res.ok) throw httpError('api', res.status, path)
  return (res.status === 204 ? null : res.json()) as Promise<T>
}

// A household (code: tenant) the user belongs to. No X-StreamIQ-Household header
// is sent yet, so the API acts in the oldest one (switcher: #193).
export type Membership = {
  id: string
  name: string | null
  role: 'admin' | 'member'
}
export const getMe = () =>
  authed<{ userId: string; tenantId: string; memberships: Membership[] }>('/me')
