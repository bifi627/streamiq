// The web gateway page's pairing requests, kept out of the .tsx so
// node:test can drive them.
import { describe, type AppError } from '../../shared/errors.ts'
import type { PairingRequest } from '../../generated/pairing.ts'

// When to ask for the requests again (ms), false = stop: a failed ask is not
// retried, each retry would open a new tunnel. Reopening the page asks again.
export const nextRequestsAsk = (failed: boolean): number | false =>
  failed ? false : 5_000

// A failed decide's line, shown until the next poll: at = the list's
// dataUpdatedAt right after the decide's refetch.
export type DecideLine = { text: string; at: number }
export const currentLine = (l: DecideLine | null, dataAt: number) =>
  l?.at === dataAt ? l.text : null

// What the section shows: hidden = nothing at all (no requests and no current
// decide line, or a 404: a gateway older than remote approval); else the
// requests (maybe none, under the line) or the error's line.
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

// Who asks: the member's name when the web app knows the user, then the
// browser's own pairing name.
export const requesterLine = (
  r: PairingRequest,
  names: Map<string, string> | undefined,
) => {
  const who = names?.get(r.user)
  return who ? `${who} · ${r.name}` : r.name
}

// A failed Approve/Reject; 404 = the request ended meanwhile (expired, or
// answered on the local page).
export const decideMessage = (e: AppError) =>
  e.context.status === 404
    ? 'This request has ended: it expired or was answered elsewhere.'
    : describe(e).message
