import { useEffect, useRef, useState } from 'react'
import { getStatus, updateGateway, type Gateway } from './api'
import { toAppError } from '../../errors'
import {
  startOutcome,
  tracked,
  updated,
  updateState,
  type Notice,
  type Started,
} from './update'
import { gatewayName } from './list'
import { event } from '../../diag'

// How long the card waits for the gateway to come back on the new version
// before it says the update didn't finish.
const UPDATE_WAIT = 2 * 60_000

// The heartbeat's newer release (g.update). A paired admin gets Update to v… over
// the tunnel when the status says it can (Windows with the logon task), else the
// reason and how to update by hand. After 202: Updating until the list shows it
// online on another version (the updater installs the latest, maybe newer). Past
// UPDATE_WAIT: same version = it hasn't happened (failed, or still backing up:
// update.log); offline = it broke mid-way, and gateway rollback restores it.
export function UpdateNotice({
  g,
  canUpdate,
}: {
  g: Gateway
  canUpdate: boolean
}) {
  const [remote, setRemote] = useState<true | string | null>(null) // null = not known
  const [updating, setUpdating] = useState<Started | null>(null)
  const [late, setLate] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const status = useRef<HTMLParagraphElement>(null)
  // Done: forget it, or the gateway going offline later reads as this update
  // again (and its rollback advice). Set during render, as React suggests.
  if (updating && updated(updating, g)) setUpdating(null)
  const active = updating !== null

  useEffect(() => {
    if (!canUpdate || !g.update || active) return
    let on = true
    getStatus(g.id)
      .then((s) => on && setRemote(s.remoteUpdate ?? null))
      .catch((e) => event(`update: status failed: ${e}`)) // the notice by hand stays
    return () => {
      on = false
    }
  }, [canUpdate, g.id, g.update, active])

  // Per started update, so a retry waits UPDATE_WAIT again.
  useEffect(() => {
    if (!updating) return
    status.current?.focus() // the focused button is gone: keep the D-pad's place
    const t = setTimeout(() => setLate(true), UPDATE_WAIT)
    return () => clearTimeout(t)
  }, [updating])

  // An update started here can unmount the focused control (the button on a
  // 409, the Updating line once done): focus then falls to <body>, outside the
  // D-pad container. Put it on the card's Status, which always renders (as
  // Pairing does). Only on this notice's own state changes, not the poll.
  const keep = useRef(false)
  useEffect(() => {
    const lost =
      !document.activeElement || document.activeElement === document.body
    if (!keep.current || !lost) return
    document
      .querySelector<HTMLElement>(`[data-gateway="${g.id}"] summary`)
      ?.focus()
    keep.current = false
  }, [g.id, active, remote, g.update])

  async function start(target: string) {
    if (
      !confirm(
        `Update "${gatewayName(g)}" to v${target}? It restarts: offline for a moment, open streams stop.`,
      )
    )
      return
    setMsg(null)
    keep.current = true
    let r
    try {
      r = await updateGateway(g.id)
    } catch (e) {
      r = toAppError(e)
    }
    const o = startOutcome(r, g.version, updating !== null)
    if ('msg' in o) setMsg(o.msg)
    else if ('remote' in o) setRemote(o.remote)
    else {
      setLate(false)
      setUpdating(o.started)
    }
  }

  const notice = updateState({
    started: updating,
    late,
    online: g.online,
    version: g.version,
    update: g.update,
    canUpdate,
    remote,
  })
  if (!notice) return null
  if (updating && tracked(notice))
    return (
      <p className="notice no-tv" role="status" tabIndex={-1} ref={status}>
        {notice === 'updating' ? (
          `Updating to v${updating.to}… The gateway is offline for a moment.`
        ) : notice !== 'notFinished' ? (
          <>
            The update to v{updating.to} hasn't happened: the gateway still runs
            v{g.version}. It failed or is still backing up: see{' '}
            <code>update.log</code> next to the gateway, at home.
            {notice === 'retry' && (
              <>
                {' '}
                <button
                  type="button"
                  onClick={() => start(g.update ?? updating.to)}
                >
                  Try again
                </button>
                {msg && <span role="alert"> {msg}</span>}
              </>
            )}
          </>
        ) : (
          <>
            The update to v{updating.to} didn't finish: the gateway isn't back.
            At home, see <code>update.log</code> next to the gateway, and run{' '}
            <code>gateway rollback</code> to go back (docs/install.md).
          </>
        )}
      </p>
    )
  if (!g.update) return null
  return (
    <Available
      update={g.update}
      notice={notice}
      remote={remote}
      msg={msg}
      start={start}
    />
  )
}

// The heartbeat's newer release, no update started here: the button, the reason
// it can't, or how to update by hand.
function Available({
  update,
  notice,
  remote,
  msg,
  start,
}: {
  update: string
  notice: Notice
  remote: true | string | null
  msg: string | null
  start: (target: string) => void
}) {
  return (
    <p className="notice no-tv">
      Update available: {update}.{' '}
      {notice === 'button' ? (
        <button type="button" onClick={() => start(update)}>
          Update to v{update}
        </button>
      ) : notice === 'reason' ? (
        <>
          Can't update from here: {remote}. Run <code>install.sh</code> on the
          gateway (Linux/macOS); on Windows run{' '}
          <code>gateway service install</code> once at home, then update from
          here.
        </>
      ) : (
        <>
          Run <code>install.sh</code> (Linux/macOS) or{' '}
          <code>gateway update</code> (Windows) on the gateway.
        </>
      )}
      {msg && <span role="alert"> {msg}</span>}
    </p>
  )
}
