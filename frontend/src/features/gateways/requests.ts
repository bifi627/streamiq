import { describe, type AppError } from '../../shared/errors.ts'
import type { PairingRequest } from '../../generated/pairing.ts'

// ms, false = stop: each retry would open a new tunnel (as nextAsk).
export const nextRequestsAsk = (failed: boolean): number | false =>
  failed ? false : 5_000

// A failed decide's line, shown until the next poll (at = dataUpdatedAt).
export type DecideLine = { text: string; at: number }
export const currentLine = (l: DecideLine | null, dataAt: number) =>
  l?.at === dataAt ? l.text : null

// hidden: no requests and no line, or a 404 (a gateway without remote approval).
export function requestsView(
  list: PairingRequest[] | undefined,
  err: AppError | null,
  line: string | null = null,
): 'hidden' | { msg: string } | PairingRequest[] {
  if (err)
    return err.context.status === 404
      ? 'hidden'
      : { msg: describe(err).message }
  return list?.length || line ? (list ?? []) : 'hidden'
}

export const requesterLine = (
  r: PairingRequest,
  names: Map<string, string> | undefined,
) => {
  const who = names?.get(r.user)
  return who ? `${who} · ${r.name}` : r.name
}

export const decideMessage = (e: AppError) =>
  e.context.status === 404
    ? 'This request has ended: it expired or was answered elsewhere.'
    : describe(e).message
