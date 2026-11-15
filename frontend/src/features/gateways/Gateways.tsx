import { useEffect, useRef, useState } from 'react'
import {
  createEnrollmentToken,
  getGateways,
  listClients,
  removeClient,
  removeGateway,
  renameGateway,
  type Client,
  type Gateway,
  type GatewayStatus,
  type Install,
} from './api'
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
import { ErrorView } from '../../ErrorView'
import { tunnelJson } from '../../tunnel'
import { useNavigate } from '@tanstack/react-router'
import { useHousehold } from '../households/household'
import { arrowFocus } from '../../focus'

// `/` (#225): straight into the library when the household has exactly one
// gateway, else the list. History replace both ways, so Back doesn't bounce.
export function Home() {
  const navigate = useNavigate()
  useEffect(() => {
    let gone = false // left before the list came: no redirect
    getGateways()
      .then((g) => (g.length === 1 ? g[0].id : null))
      .catch(() => null) // the list shows the error
      .then((id) => {
        if (gone) return
        if (id)
          navigate({
            to: '/g/$gatewayId',
            params: { gatewayId: id },
            replace: true,
          })
        else navigate({ to: '/gateways', replace: true })
      })
    return () => {
      gone = true
    }
  }, [navigate])
  return null
}

// Gateways list + "Add gateway" (onboarding flow 1). Polls so a freshly installed
// gateway shows up, and online/offline stays current. ponytail: 5s poll, push
// updates over a socket if the list ever gets big. Add/Remove are admin-only
// (#190): hidden for a member (the API answers 403 anyway) and until /me is in;
// a member gets told an admin does them instead (#211).
export function Gateways() {
  const [gateways, setGateways] = useState<Gateway[] | null>(null) // null = loading
  const role = useHousehold().current?.role
  const admin = role === 'admin'
  const [install, setInstall] = useState<Install | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [err, setErr] = useState<AppError | null>(null)
  const navigate = useNavigate()
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

  useEffect(() => {
    const load = () =>
      getGateways()
        .then((d) => {
          setGateways(d)
          setErr(null)
        })
        .catch((e) => setErr(toAppError(e)))
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])

  async function remove(d: Gateway) {
    if (
      !confirm(
        `Remove "${d.name ?? 'gateway'}"? It disconnects now and must be installed again to come back.`,
      )
    )
      return
    try {
      await removeGateway(d.id)
      setGateways((gs) => gs && gs.filter((g) => g.id !== d.id))
    } catch (e) {
      setErr(toAppError(e))
    }
  }

  // null = renamed; else the error to show in the form.
  async function rename(d: Gateway, name: string) {
    try {
      const stored = await renameGateway(d.id, name)
      setGateways(
        (gs) =>
          gs && gs.map((g) => (g.id === d.id ? { ...g, name: stored } : g)),
      )
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
  function copy(label: string, cmd: string) {
    navigator.clipboard
      ?.writeText(cmd)
      .then(() => setCopied(label))
      .catch(() => {})
  }

  return (
    <section className="gateways" onKeyDown={arrowFocus}>
      <div className="head">
        <h1>Gateways</h1>
        {admin && (
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
      {gateways?.length === 0 && !err && (
        <p>
          No gateways yet.
          {role === 'member' && ' Ask a household admin to add one.'}
        </p>
      )}
      {!!gateways?.length && (
        <ul className="cards">
          {gateways.map((d) => (
            <li key={d.id} className="card">
              <div className="card-head">
                <GatewayName
                  name={d.name ?? 'gateway'}
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
                d.update && (
                  <p className="notice">
                    Update available: {d.update}. Run <code>install.sh</code>{' '}
                    (Linux/macOS) or <code>gateway update</code> (Windows) on
                    the gateway.
                  </p>
                )
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
              {admin && (
                <PairedClients
                  g={d}
                  unpaired={unpaired.has(d.id)}
                  onRemovedSelf={() => removedSelf(d.id)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const RemoveButton = ({ onClick }: { onClick: () => void }) => (
  <button type="button" className="end" onClick={onClick}>
    Remove
  </button>
)

// The name, plus an inline Rename for an admin while the gateway is online and
// this browser is paired with it (#310, #329). Enter saves (form submit),
// Escape / the remote's Back cancels; arrowFocus reaches the controls.
function GatewayName({
  name,
  rename,
}: {
  name: string
  rename?: (name: string) => Promise<string | null>
}) {
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
        <h2>{name}</h2>
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
        aria-label="Gateway name"
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
  legacy: 'admin API key: reconnect Jellyfin on the gateway page',
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

// Admin-only (#311): the gateway's paired clients over the shared tunnel
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
              <span>
                {c.name}
                {c.self && <b> (this browser)</b>} · paired{' '}
                {new Date(c.addedAt).toLocaleDateString()}
              </span>
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

const clientsMessage = (e: AppError) =>
  isKind(e, 'not-paired')
    ? 'Pair this browser to see them.'
    : e.context.status === 404
      ? 'This gateway is too old to list them: update it.'
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
