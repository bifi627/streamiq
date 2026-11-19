// The gateways page's decisions (#532, #605), kept out of the .tsx so
// node:test can drive them.
import { describe, isKind, renameMessage, type AppError } from '../../errors.ts'

// An action's error, tagged with the list's dataUpdatedAt at failure: shown
// until the next successful poll, as the load error is. The load error wins.
export type ActErr = { e: AppError; at: number }
export const shownError = (
  load: AppError | null,
  act: ActErr | null,
  dataAt: number,
): AppError | null => load ?? (act?.at === dataAt ? act.e : null)

// Rename and Update go over the tunnel: an admin, the gateway online, and this
// browser paired with it (a pin, #329). A stale pin keeps it: the error says so.
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

// 404: a gateway older than #365, or the client was removed meanwhile.
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
