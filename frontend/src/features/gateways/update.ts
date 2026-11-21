import { AppError, describe } from '../../errors.ts'

// A remote update the gateway card started: the target it named and
// the version the gateway ran before.
export type Started = { to: string; from: string | null }

// Done once the list shows the gateway online on another version than before:
// the updater installs the latest release, maybe newer than `to`.
export const updated = (
  u: Started,
  g: { online: boolean; version: string | null },
) => g.online && g.version !== u.from

// Which notice the gateway card shows: from the started update (null = none) and
// whether UPDATE_WAIT has passed (late), the gateway's fields, whether this browser
// may update it, and the status's answer (remote: null = not known, true = the
// button works, a string = why not). A finished update no longer counts. Not
// happened + may update = retry: the button again (the gateway refuses one while
// its updater still runs).
export type Notice =
  | 'updating'
  | 'notHappened'
  | 'retry'
  | 'notFinished'
  | 'button'
  | 'reason'
  | 'byHand'
  | null

/** A notice about an update started here (the Updating line and what follows). */
export const tracked = (n: Notice) =>
  n === 'updating' ||
  n === 'notHappened' ||
  n === 'retry' ||
  n === 'notFinished'

export function updateState(x: {
  started: Started | null
  late: boolean
  online: boolean
  version: string | null
  update: string | null
  canUpdate: boolean
  remote: true | string | null
}): Notice {
  if (x.started && !updated(x.started, x)) {
    if (!x.late) return 'updating'
    if (!x.online) return 'notFinished'
    return x.canUpdate ? 'retry' : 'notHappened'
  }
  if (!x.update) return null
  if (x.canUpdate && x.remote === true) return 'button'
  if (x.canUpdate && typeof x.remote === 'string') return 'reason'
  return 'byHand'
}

// What Update / Try again leads to: the gateway's answer
// (202: the version it installs; 409: why not) or the error. A refusal while
// an update is tracked (a retry) is a line next to Try again, so the card
// keeps that update and its rollback advice; else it's the notice's reason.
export function startOutcome(
  r: { version: string } | { reason: string } | AppError,
  from: string | null,
  tracking: boolean,
): { msg: string } | { remote: string } | { started: Started } {
  if (r instanceof AppError) return { msg: describe(r).message }
  if ('reason' in r)
    return tracking ? { msg: `Refused: ${r.reason}.` } : { remote: r.reason }
  return { started: { to: r.version, from } }
}
