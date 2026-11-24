// The gateways page's decisions, kept out of the .tsx so
// node:test can drive them.
import {
  describe,
  isKind,
  renameMessage,
  type AppError,
} from '../../shared/errors.ts'
import { describe as describeProbe } from '../player/profile.ts'
import type { Profile } from '../../generated/pairing.ts'

// An action's error, tagged with the list's dataUpdatedAt at failure: shown
// until the next successful poll, as the load error is. The load error wins.
export type ActErr = { e: AppError; at: number }
export const shownError = (
  load: AppError | null,
  act: ActErr | null,
  dataAt: number,
): AppError | null => load ?? (act?.at === dataAt ? act.e : null)

// Rename and Update go over the tunnel: an admin, the gateway online, and this
// browser paired with it (a pin). A stale pin keeps it: the error says so.
export const canManage = (admin: boolean, online: boolean, pinned: boolean) =>
  admin && online && pinned

// The Paired clients section's status line; null = the list (or its empty line).
export function clientsNote(o: {
  online: boolean
  unpaired: boolean
  msg: string | null
  loaded: boolean
}): string | null {
  if (!o.online) return 'Gateway offline: the list comes from it.'
  if (o.unpaired) return 'This browser was removed: pair it again.'
  return o.msg ?? (o.loaded ? null : 'loading…')
}

// 404: a gateway without client rename, or the client was removed meanwhile.
export const clientRenameMessage = (e: AppError) =>
  e.context.status === 404
    ? 'Not renamed: update the gateway, or reopen the list if this client was removed.'
    : renameMessage(e)

export const clientsMessage = (e: AppError) =>
  isKind(e, 'not-paired')
    ? 'Pair this browser to see them.'
    : describe(e).message

// Why the Status details aren't there.
export const detailsMessage = (e: AppError) =>
  isKind(e, 'not-paired')
    ? 'pair this browser to see them'
    : e.context.status === 404
      ? 'gateway too old to report them: update it'
      : `unavailable (${e.message})`

// What a client's Remove leaves: done = 'self' (this browser is gone:
// the page offers Pair again), 'row' (drop another client's row; 404 = not
// paired anymore, removed elsewhere, so the same), 'kept' (this browser's own
// row with a 404: nothing changes), null = failed; msg = the section's line,
// null once it went through, so an earlier failed Remove's error goes too.
export function removeOutcome(
  e: AppError | null,
  self: boolean,
): { done: 'self' | 'row' | 'kept' | null; msg: string | null } {
  if (e && e.context.status !== 404)
    return { done: null, msg: clientsMessage(e) }
  if (!self) return { done: 'row', msg: null }
  return { done: e ? 'kept' : 'self', msg: null }
}

/** A gateway's name, or "gateway" before it has one. */
export const gatewayName = (g: { name: string | null }) => g.name ?? 'gateway'

// A paired client's last capability probe, as the diagnostics report words it.
export const profileLine = (p: Profile | null) =>
  p
    ? `${describeProbe(p.probe)}${p.compatible ? ' · Compatible mode' : ''} · probed ${new Date(p.probedAt).toLocaleString()}`
    : 'Not probed yet'

// The overview card's status dot: what a gateway can't do first.
export type Dot = 'required' | 'offline' | 'update' | 'online'
export const dotOf = (g: {
  online: boolean
  update: string | null
  upgradeRequired: boolean
}): Dot =>
  g.upgradeRequired
    ? 'required'
    : !g.online
      ? 'offline'
      : g.update
        ? 'update'
        : 'online'
export const dotLabel: Record<Dot, string> = {
  required: 'Update required',
  offline: 'Offline',
  update: 'Update available',
  online: 'Online',
}

/** The overview's order: the active gateway first, the rest as listed. */
export const activeFirst = <G extends { id: string }>(
  gateways: G[],
  active: string | null,
) => [
  ...gateways.filter((g) => g.id === active),
  ...gateways.filter((g) => g.id !== active),
]
