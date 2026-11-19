// A remote update the gateway card started (#312): the target it named and
// the version the gateway ran before.
export type Started = { to: string; from: string | null }

// Done once the list shows the gateway online on another version than before:
// the updater installs the latest release, maybe newer than `to`.
export const updated = (
  u: Started,
  g: { online: boolean; version: string | null },
) => g.online && g.version !== u.from

// Which notice the gateway card shows about an update (#537): the started
// update (none = null) and whether UPDATE_WAIT has passed (late), the
// gateway's fields, whether this browser may update it, and the status's
// answer (remote: null = not known, true = the button works, a string = why
// not). A started update that's done no longer counts: back to the offer.
export type Notice =
  | 'updating'
  | 'notHappened'
  | 'notFinished'
  | 'button'
  | 'reason'
  | 'byHand'
  | null

export function updateState(x: {
  started: Started | null
  late: boolean
  online: boolean
  version: string | null
  update: string | null
  canUpdate: boolean
  remote: true | string | null
}): Notice {
  if (x.started && !updated(x.started, x))
    return !x.late ? 'updating' : x.online ? 'notHappened' : 'notFinished'
  if (!x.update) return null
  if (x.canUpdate && x.remote === true) return 'button'
  if (x.canUpdate && typeof x.remote === 'string') return 'reason'
  return 'byHand'
}
