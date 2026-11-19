import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  createEnrollmentToken,
  listClients,
  removeClient,
  renameClient,
  removeGateway,
  renameGateway,
  type Client,
  type Gateway,
  type GatewayStatus,
  type Install,
  updateGateway,
  useGateways,
} from './api'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pairing } from '../pairing/Pairing'
import { dropShared, share } from '../pairing/connect'
import { deletePin } from '../pairing/store'
import {
  AppError,
  describe,
  renameMessage,
  isKind,
  toAppError,
} from '../../errors'
import { isBack } from '../library/items'
import { ErrorView, State } from '../../ErrorView'
import { copyText } from '../../clipboard'
import { tunnelJson } from '../../tunnel'
import { Link, useNavigate } from '@tanstack/react-router'
import { useHousehold } from '../households/household'
import { arrowFocus } from '../../focus'
import { updated, updateState, type Started } from './update'

// `/` (#225): straight into the library when the household has exactly one
// gateway, else the list. History replace both ways, so Back doesn't bounce.
export function Home() {
  const navigate = useNavigate()
  const { data, isError } = useGateways()
  useEffect(() => {
    if (!data && !isError) return // the list shows the error
    if (data?.length === 1)
      navigate({
        to: '/g/$gatewayId',
        params: { gatewayId: data[0].id },
        replace: true,
      })
    else navigate({ to: '/gateways', replace: true })
  }, [data, isError, navigate])
  return null
}

// Gateways list + "Add gateway" (onboarding flow 1). Polls so a freshly installed
// gateway shows up, and online/offline stays current. ponytail: 5s poll, push
// updates over a socket if the list ever gets big. Add/Remove are admin-only
// (#190): hidden for a member (the API answers 403 anyway) and until /me is in;
// a member gets told an admin does them instead (#211).
// oxlint-disable-next-line complexity -- render branching
export function Gateways() {
  const q = useGateways(5000)
  const qc = useQueryClient()
  const gateways = q.data ?? null // null = loading
  const role = useHousehold().current?.role
  const admin = role === 'admin'
  const [install, setInstall] = useState<Install | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  // An action's error, until the next successful poll (as the load error).
  const [actErr, setActErr] = useState<{ e: AppError; at: number } | null>(null)
  // Tagged with the data at failure, not at click: a poll may land meanwhile.
  const setErr = (e: AppError) =>
    setActErr({ e, at: qc.getQueryState(['gateways'])?.dataUpdatedAt ?? 0 })
  const err = q.error
    ? toAppError(q.error)
    : actErr?.at === q.dataUpdatedAt
      ? actErr.e
      : null
  const navigate = useNavigate()
  const removing = useMutation({
    mutationFn: removeGateway,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gateways'] }),
    onError: (e) => setErr(toAppError(e)),
  })
  // Gateways this browser holds a pin for: Rename goes over the tunnel, so it
  // shows only there (#329). A stale pin keeps it: the rename's error says so.
  // Each card's Pairing reports it (onPin, onPaired).
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set())
  const pin = (id: string, p: boolean) =>
    setPinned((s) => {
      const n = new Set(s)
      if (p) n.add(id)
      else n.delete(id)
      return n
    })
  // Gateways this browser removed itself from (#311): Pair shows again.
  const [unpaired, setUnpaired] = useState<ReadonlySet<string>>(new Set())
  async function removedSelf(id: string) {
    await deletePin(id).catch(() => {}) // a stale pin would only fail later
    dropShared(id) // the gateway closed it anyway
    pin(id, false)
    setUnpaired((s) => new Set(s).add(id))
  }

  function remove(d: Gateway) {
    if (
      !confirm(
        `Remove "${d.name ?? 'gateway'}"? It disconnects now and must be installed again to come back.`,
      )
    )
      return
    removing.mutate(d.id)
  }

  // null = renamed; else the error to show in the form.
  async function rename(d: Gateway, name: string) {
    try {
      const stored = await renameGateway(d.id, name)
      // Shown at once; the gateway tells the API with a heartbeat on rename.
      qc.setQueryData<Gateway[]>(['gateways'], (gs) =>
        gs?.map((g) => (g.id === d.id ? { ...g, name: stored } : g)),
      )
      void qc.invalidateQueries({ queryKey: ['gateways'] })
      return null
    } catch (e) {
      return renameMessage(toAppError(e))
    }
  }

  async function addGateway() {
    try {
      setInstall(await createEnrollmentToken())
      setCopied(null)
    } catch (e) {
      setErr(toAppError(e))
    }
  }

  // No clipboard API on plain http (a LAN address): a click on the command
  // selects all of it instead (CSS user-select: all).
  const copy = (label: string, cmd: string) =>
    copyText(cmd).then((ok) => ok && setCopied(label))

  return (
    <section className="gateways" onKeyDown={arrowFocus}>
      <div className="head">
        <h1>Gateways</h1>
        {/* No gateways: the empty state carries it instead. */}
        {admin && gateways?.length !== 0 && (
          <button type="button" className="no-tv" onClick={addGateway}>
            Add gateway
          </button>
        )}
      </div>
      {err && <ErrorView error={err} />}
      {install && (
        <div className="card install no-tv">
          <h2>Add a gateway</h2>
          <p className="muted">
            Run one of these on your NAS or PC. The token works once and expires
            at {new Date(install.expiresAt).toLocaleTimeString()}.
          </p>
          {[
            ['bash', install.installCommand],
            ['PowerShell', install.installCommandPowershell],
          ].map(([label, cmd]) => (
            <div key={label}>
              <div className="cmd-head">
                <b>
                  {label}
                  {cmd.includes('go run') && (
                    <span className="meta muted">
                      {' '}
                      (from <code>gateway/</code>)
                    </span>
                  )}
                </b>
                <button type="button" onClick={() => copy(label, cmd)}>
                  {copied === label ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre>{cmd}</pre>
            </div>
          ))}
        </div>
      )}
      {!gateways && !err && (
        <ul className="cards" role="status" aria-label="Loading">
          {[0, 1].map((n) => (
            <li key={n} className="card">
              <div className="ph ph-h2" />
              <div className="ph ph-line short" />
              <div className="ph ph-btn" />
            </li>
          ))}
        </ul>
      )}
      {gateways?.length === 0 && (
        <State
          icon="gateway"
          title="No gateways yet."
          text={role === 'member' && 'Ask a household admin to add one.'}
        >
          {admin && (
            <p className="state-actions no-tv">
              <button type="button" className="primary" onClick={addGateway}>
                Add gateway
              </button>
            </p>
          )}
        </State>
      )}
      {!!gateways?.length && (
        <ul className="cards">
          {/* oxlint-disable-next-line complexity -- render branching */}
          {gateways.map((d) => (
            <li key={d.id} className="card" data-gateway={d.id}>
              <div className="card-head">
                <EditableName
                  name={d.name ?? 'gateway'}
                  label="Gateway name"
                  hint={STORED}
                  rename={
                    admin && d.online && pinned.has(d.id)
                      ? (n) => rename(d, n)
                      : undefined
                  }
                />
                <span className="chip">
                  <span className={d.online ? 'dot online' : 'dot'} />
                  {d.online ? 'Online' : 'Offline'}
                </span>
              </div>
              {d.version && (
                <span className="meta muted">Version {d.version}</span>
              )}
              {d.upgradeRequired ? (
                <p className="notice">
                  Update required: rerun the install command on the gateway.
                </p>
              ) : (
                <UpdateNotice
                  g={d}
                  canUpdate={admin && d.online && pinned.has(d.id)}
                />
              )}
              {d.online ? (
                // Pair this browser stands where Open is until it's paired (#226).
                <Pairing
                  gatewayId={d.id}
                  lanUrl={d.lanUrl}
                  needsPair={unpaired.has(d.id)}
                  onPin={(p) => pin(d.id, p)}
                  onPaired={() => {
                    pin(d.id, true)
                    setUnpaired((s) => {
                      const n = new Set(s)
                      n.delete(d.id)
                      return n
                    })
                  }}
                  open={() =>
                    navigate({
                      to: '/g/$gatewayId',
                      params: { gatewayId: d.id },
                    })
                  }
                >
                  {/* Every device (#248); the library shows it only in TV mode. */}
                  {!unpaired.has(d.id) && (
                    <Link
                      to="/g/$gatewayId/screen"
                      params={{ gatewayId: d.id }}
                    >
                      Use as screen
                    </Link>
                  )}
                  {d.lanUrl && (
                    <a href={d.lanUrl} target="_blank" rel="noreferrer">
                      Gateway page
                    </a>
                  )}
                  {admin && <RemoveButton onClick={() => remove(d)} />}
                </Pairing>
              ) : (
                admin && (
                  <div className="actions">
                    <RemoveButton onClick={() => remove(d)} />
                  </div>
                )
              )}
              <StatusDetails g={d} />
              {/* A member's list is just this browser (#341). */}
              <PairedClients
                g={d}
                unpaired={unpaired.has(d.id)}
                onRemovedSelf={() => removedSelf(d.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// How long the card waits for the gateway to come back on the new version
// before it says the update didn't finish (#312).
const UPDATE_WAIT = 2 * 60_000

// The heartbeat's newer release (g.update). An admin whose browser is paired
// gets Update to v… over the tunnel (#312) when the gateway's status says it
// can (Windows with the logon task), else the reason and how to update by hand.
// After 202: Updating until the list shows it online on another version than
// before (the updater installs the latest release, maybe newer than the one
// named). Not there within UPDATE_WAIT: still on the old version = the update
// hasn't happened (failed, or still backing up: update.log); offline = it broke
// mid-way, and gateway rollback brings back the old version.
function UpdateNotice({ g, canUpdate }: { g: Gateway; canUpdate: boolean }) {
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
    const { session, release } = share(g.id)
    session
      .then((x) => tunnelJson<GatewayStatus>(x.pc, '/streamiq/status'))
      .then((s) => on && setRemote(s.remoteUpdate ?? null))
      .catch(() => {}) // the notice by hand stays
      .finally(release)
    return () => {
      on = false
    }
  }, [canUpdate, g.id, g.update, active])

  // Per started update, so a retry (#564) waits UPDATE_WAIT again.
  useEffect(() => {
    if (!updating) return
    status.current?.focus() // the focused button is gone: keep the D-pad's place
    const t = setTimeout(() => setLate(true), UPDATE_WAIT)
    return () => clearTimeout(t)
  }, [updating])

  // An update started here can unmount the focused control (the button on a
  // 409, the Updating line once done): focus then falls to <body>, outside the
  // D-pad container. Put it on the card's Status, which always renders (#226,
  // as Pairing does). Only on this notice's own state changes, not the poll.
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
        `Update "${g.name ?? 'gateway'}" to v${target}? It restarts: offline for a moment, open streams stop.`,
      )
    )
      return
    setMsg(null)
    keep.current = true
    try {
      const r = await updateGateway(g.id)
      // A refused retry (#564): next to Try again, still tracking the update
      // that may be running (its rollback advice if it breaks).
      if ('reason' in r && updating) setMsg(`Refused: ${r.reason}.`)
      else if ('reason' in r) setRemote(r.reason)
      else {
        setLate(false)
        setUpdating({ to: r.version, from: g.version })
      }
    } catch (e) {
      setMsg(describe(toAppError(e)).message)
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
  if (
    notice === 'updating' ||
    notice === 'notHappened' ||
    notice === 'retry' ||
    notice === 'notFinished'
  )
    return (
      <p className="notice" role="status" tabIndex={-1} ref={status}>
        {notice === 'updating' ? (
          `Updating to v${updating!.to}… The gateway is offline for a moment.`
        ) : notice !== 'notFinished' ? (
          <>
            The update to v{updating!.to} hasn't happened: the gateway still
            runs v{g.version}. It failed or is still backing up: see{' '}
            <code>update.log</code> next to the gateway, at home.
            {notice === 'retry' && (
              <>
                {' '}
                <button
                  type="button"
                  onClick={() => start(g.update ?? updating!.to)}
                >
                  Try again
                </button>
                {msg && <span role="alert"> {msg}</span>}
              </>
            )}
          </>
        ) : (
          <>
            The update to v{updating!.to} didn't finish: the gateway isn't back.
            At home, see <code>update.log</code> next to the gateway, and run{' '}
            <code>gateway rollback</code> to go back (docs/install.md).
          </>
        )}
      </p>
    )
  return (
    <p className="notice">
      Update available: {g.update}.{' '}
      {notice === 'button' ? (
        <button type="button" onClick={() => start(g.update!)}>
          Update to v{g.update}
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

const RemoveButton = ({ onClick }: { onClick: () => void }) => (
  <button type="button" className="end" onClick={onClick}>
    Remove
  </button>
)

// The hint on inputs whose text leaves the user's hardware: our DB or Firebase
// (#413). Not on what only the gateway keeps (client names): that's their box.
export const STORED = 'Saved by StreamIQ.'

// The name, plus an inline Rename: a gateway's for an admin while it is online
// and this browser is paired with it (#310, #329), a paired client's (#365).
// Enter saves (form submit), Escape / the remote's Back cancels; arrowFocus
// reaches the controls. children replaces the shown name (the <h2> by default).
// hint: a line under the input while editing (#413).
export function EditableName({
  name,
  label,
  rename,
  hint,
  children,
}: {
  name: string
  label: string
  rename?: (name: string) => Promise<string | null>
  hint?: string
  children?: ReactNode
}) {
  const hintId = useId()
  const [draft, setDraft] = useState<string | null>(null) // null = not editing
  const [error, setError] = useState<string | null>(null)
  const renameBtn = useRef<HTMLButtonElement>(null)
  const edited = useRef(false)
  // Closing the form unmounts the focused control: focus Rename again, or the
  // D-pad (arrowFocus on the section) loses its place, as in Pairing (#226).
  useEffect(() => {
    if (draft === null && edited.current) renameBtn.current?.focus()
    edited.current = draft !== null
  }, [draft])
  // !rename: went offline mid-edit, so the name only.
  if (draft === null || !rename)
    return (
      <div className="name">
        {children ?? <h2>{name}</h2>}
        {rename && (
          <button
            ref={renameBtn}
            type="button"
            className="link"
            onClick={() => {
              setDraft(name)
              setError(null)
            }}
          >
            Rename
          </button>
        )}
      </div>
    )
  return (
    <form
      className="name"
      onSubmit={async (e) => {
        e.preventDefault()
        const e2 = await rename(draft.trim())
        if (e2) setError(e2)
        else setDraft(null)
      }}
      onKeyDown={(e) => {
        if (!isBack(e.nativeEvent)) return
        e.preventDefault() // else the browser's own Back runs too (webOS remote)
        setDraft(null)
      }}
    >
      <input
        aria-label={label}
        aria-describedby={hint && hintId}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setError(null)
        }}
        maxLength={100}
        required
        pattern=".*\S.*"
        autoFocus
      />
      <button type="submit" className="primary">
        Save
      </button>
      <button type="button" onClick={() => setDraft(null)}>
        Cancel
      </button>
      {hint && (
        <p id={hintId} className="hint muted">
          {hint}
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

const tokenText = {
  ok: 'token set',
  missing: 'token missing: open the gateway page and Connect Jellyfin',
}

// Liveness from the heartbeat (works unpaired); the details from the gateway API
// over the tunnel (#140), which needs this browser paired.
function StatusDetails({ g }: { g: Gateway }) {
  const [open, setOpen] = useState(false)
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Status</summary>
      <ul>
        <li>
          ID <code>{g.id}</code>
        </li>
        <li>
          StreamIQ:{' '}
          {g.online && g.lastSeenAt
            ? `connected, last heartbeat ${new Date(g.lastSeenAt).toLocaleTimeString()}`
            : 'not connected'}
        </li>
        <li>Version {g.version ?? 'unknown'}</li>
        {open && <Details g={g} />}
      </ul>
    </details>
  )
}

// The gateway's paired clients (#311; a member sees only its own, #341) over the shared tunnel
// session, loaded each time the section opens. Removing one ends its sessions;
// removing this browser closes the tunnel, and the card offers Pair again.
function PairedClients({
  g,
  unpaired,
  onRemovedSelf,
}: {
  g: Gateway
  unpaired: boolean
  onRemovedSelf: () => void
}) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<Client[] | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const summary = useRef<HTMLElement>(null)
  const live = open && g.online && !unpaired
  useEffect(() => {
    if (!live) return
    let on = true
    listClients(g.id)
      .then((l) => {
        if (!on) return
        setList(l)
        setMsg(null)
      })
      .catch((x) => {
        if (on) setMsg(clientsMessage(toAppError(x)))
      })
    return () => {
      on = false
    }
  }, [live, g.id])
  const note = !g.online
    ? 'Gateway offline: the list comes from it.'
    : unpaired
      ? 'This browser was removed: pair it again.'
      : (msg ?? (list ? null : 'loading…'))
  const shown = g.online && !unpaired ? list : null

  // null = renamed (#365); else the error to show in the form.
  async function rename(c: Client, name: string) {
    try {
      const stored = await renameClient(g.id, c.keyFp, name)
      setList(
        (l) =>
          l && l.map((x) => (x.keyFp === c.keyFp ? { ...x, name: stored } : x)),
      )
      return null
    } catch (x) {
      return clientRenameMessage(toAppError(x))
    }
  }

  async function remove(c: Client) {
    if (
      !confirm(
        c.self
          ? 'Remove this browser? It must pair again to use this gateway.'
          : `Remove "${c.name}"? Its streams stop and it must pair again.`,
      )
    )
      return
    try {
      await removeClient(g.id, c.keyFp)
      if (c.self) onRemovedSelf()
    } catch (x) {
      const e = toAppError(x)
      // 404: not paired anymore (removed elsewhere): drop the row all the same.
      if (e.context.status !== 404) return setMsg(clientsMessage(e))
    }
    if (!c.self) setList((l) => l && l.filter((x) => x.keyFp !== c.keyFp))
    // The focused Remove is gone: keep the D-pad's place (#226), as Rename does.
    summary.current?.focus()
  }

  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary ref={summary}>Paired clients</summary>
      {note && <p role="status">{note}</p>}
      {shown?.length === 0 && <p>No paired clients.</p>}
      {!!shown?.length && (
        <ul className="clients">
          {shown.map((c) => (
            <li key={c.keyFp}>
              <EditableName
                name={c.name}
                label="Client name"
                rename={(n) => rename(c, n)}
              >
                <span>
                  {c.name}
                  {c.self && <b> (this browser)</b>} · paired{' '}
                  {new Date(c.addedAt).toLocaleDateString()}
                </span>
              </EditableName>
              <button type="button" className="link" onClick={() => remove(c)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}

// 404: a gateway older than #365, or the client was removed meanwhile.
const clientRenameMessage = (e: AppError) =>
  e.context.status === 404
    ? 'Not renamed: update the gateway, or reopen the list if this client was removed.'
    : renameMessage(e)

const clientsMessage = (e: AppError) =>
  isKind(e, 'not-paired')
    ? 'Pair this browser to see them.'
    : describe(e).message

const transcodingText: Record<string, string> = {
  nvenc: 'GPU (nvenc)',
  none: 'CPU',
  unmanaged: 'not managed by StreamIQ',
}

type Cached = { at: string; s: GatewayStatus }
const cacheKey = (id: string) => `streamiq.gatewayStatus.${id}`

// Offline view: the last response per gateway, from localStorage (may be
// unavailable: private mode, blocked storage).
function readCache(id: string): Cached | null {
  try {
    return JSON.parse(localStorage.getItem(cacheKey(id)) ?? 'null')
  } catch {
    return null
  }
}

function writeCache(id: string, s: GatewayStatus) {
  try {
    localStorage.setItem(
      cacheKey(id),
      JSON.stringify({ at: new Date().toISOString(), s }),
    )
  } catch {
    // ignore: the live view still works
  }
}

// The gateway's shared tunnel session (#152) while online, released once the
// status is in; offline, the cached last response, dated.
function Details({ g }: { g: Gateway }) {
  const [s, setS] = useState<GatewayStatus | null>(null)
  const [msg, setMsg] = useState('checking…')
  useEffect(() => {
    if (!g.online) return
    let live = true
    const { session, release } = share(g.id)
    session
      .then((x) => tunnelJson<GatewayStatus>(x.pc, '/streamiq/status'))
      .then((r) => {
        writeCache(g.id, r)
        if (live) setS(r)
      })
      .catch((x) => {
        const e = toAppError(x)
        if (live)
          setMsg(
            isKind(e, 'not-paired')
              ? 'pair this browser to see them'
              : e.context.status === 404
                ? 'gateway too old to report them: update it'
                : `unavailable (${e.message})`,
          )
      })
      .finally(release)
    return () => {
      live = false
    }
  }, [g.id, g.online])

  if (!g.online) {
    const c = readCache(g.id)
    if (!c) return <li>Details: gateway offline, none seen yet</li>
    return (
      <>
        <li>Gateway offline. As of {new Date(c.at).toLocaleString()}:</li>
        <StatusLines s={c.s} />
      </>
    )
  }
  return s ? <StatusLines s={s} /> : <li>Details: {msg}</li>
}

// oxlint-disable-next-line complexity -- render branching
function StatusLines({ s }: { s: GatewayStatus }) {
  const jf = s.jellyfin
  return (
    <>
      {(s.os || s.startedAt) && (
        <li>
          {s.os && `${s.os}/${s.arch ?? '?'}`}
          {s.os && s.startedAt && ' · '}
          {s.startedAt &&
            `running since ${new Date(s.startedAt).toLocaleString()}`}
        </li>
      )}
      <li>
        Jellyfin:{' '}
        {!jf
          ? 'unknown'
          : !jf.reachable
            ? 'not reachable'
            : `reachable, version ${jf.version ?? '?'}`}
        {jf?.untested && <b> · not tested with this gateway</b>}
        {jf?.token && ` · ${tokenText[jf.token]}`}
      </li>
      {jf?.offline && (
        <li>
          {jf.offline === 'enforced'
            ? 'Offline: enforced'
            : 'Online lookups allowed'}
        </li>
      )}
      <li>
        Paired browsers: {(s.pairedClients ?? '?').toLocaleString()} · open
        sessions: {(s.activeSessions ?? '?').toLocaleString()}
      </li>
      {s.transcoding && (
        <li>Transcoding: {transcodingText[s.transcoding] ?? s.transcoding}</li>
      )}
    </>
  )
}
