import { useEffect, useState } from 'react'
import {
  createEnrollmentToken,
  getGateways,
  removeGateway,
  type Gateway,
  type GatewayStatus,
  type Install,
} from './api'
import { Pairing } from '../pairing/Pairing'
import { share } from '../pairing/connect'
import { AppError, isKind, toAppError } from '../../errors'
import { ErrorView } from '../../ErrorView'
import { tunnelJson } from '../../tunnel'
import { getMe } from '../../api'
import { useNavigate } from '@tanstack/react-router'

// Gateways list + "Add gateway" (onboarding flow 1). Polls so a freshly installed
// gateway shows up, and online/offline stays current. ponytail: 5s poll, push
// updates over a socket if the list ever gets big. Add/Remove are admin-only
// (#190): hidden for a member (the API answers 403 anyway) and until /me is in.
export function Gateways() {
  const [gateways, setGateways] = useState<Gateway[]>([])
  const [admin, setAdmin] = useState(false)
  const [install, setInstall] = useState<Install | null>(null)
  const [err, setErr] = useState<AppError | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    const load = () =>
      getGateways()
        .then((d) => {
          setGateways(d)
          setErr(null)
        })
        .catch((e) => setErr(toAppError(e)))
    load()
    getMe()
      .then((m) =>
        setAdmin(
          m.memberships.find((x) => x.id === m.tenantId)?.role === 'admin',
        ),
      )
      .catch((e) => setErr(toAppError(e)))
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
      setGateways((gs) => gs.filter((g) => g.id !== d.id))
    } catch (e) {
      setErr(toAppError(e))
    }
  }

  async function addGateway() {
    try {
      setInstall(await createEnrollmentToken())
    } catch (e) {
      setErr(toAppError(e))
    }
  }

  return (
    <section>
      <h2>Gateways</h2>
      {err && <ErrorView error={err} />}
      {gateways.length === 0 ? (
        !err && <p>No gateways yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {gateways.map((d) => (
            <li key={d.id}>
              <span style={{ color: d.online ? 'green' : '#888' }}>●</span>{' '}
              {d.name ?? 'gateway'}{' '}
              <code style={{ fontSize: '0.8em', color: '#888' }}>{d.id}</code> —{' '}
              {d.upgradeRequired ? (
                <b>update required: rerun the install command on the gateway</b>
              ) : d.online ? (
                'online'
              ) : (
                'offline'
              )}
              {d.version && ` · ${d.version}`}
              {d.online && d.lanUrl && (
                <>
                  {' · '}
                  <a href={d.lanUrl} target="_blank" rel="noreferrer">
                    Open gateway page
                  </a>
                </>
              )}
              {d.online && (
                <>
                  {' · '}
                  <button
                    type="button"
                    onClick={() =>
                      navigate({
                        to: '/g/$gatewayId',
                        params: { gatewayId: d.id },
                      })
                    }
                  >
                    Open
                  </button>
                  <Pairing gatewayId={d.id} lanUrl={d.lanUrl} />
                </>
              )}{' '}
              {admin && (
                <button type="button" onClick={() => remove(d)}>
                  Remove
                </button>
              )}
              <StatusDetails g={d} />
            </li>
          ))}
        </ul>
      )}
      {admin && (
        <button type="button" onClick={addGateway}>
          Add gateway
        </button>
      )}
      {install && (
        <div>
          <p>
            Run this on your NAS/PC (one-time token, expires{' '}
            {new Date(install.expiresAt).toLocaleTimeString()}):
          </p>
          {[
            ['bash', install.installCommand],
            ['PowerShell', install.installCommandPowershell],
          ].map(([label, cmd]) => (
            <div key={label}>
              <b>{label}</b>
              {cmd.includes('go run') && (
                <>
                  {' '}
                  (from <code>gateway/</code>)
                </>
              )}
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {cmd}
              </pre>
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(cmd)}
              >
                Copy
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
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
          StreamIQ:{' '}
          {g.online && g.lastSeenAt
            ? `connected, last heartbeat ${new Date(g.lastSeenAt).toLocaleTimeString()}`
            : 'not connected'}
        </li>
        <li>
          Version {g.version ?? 'unknown'}
          {g.update && (
            <b>
              {' '}
              · update available: {g.update}, run <code>install.sh</code>{' '}
              (Linux/macOS) or <code>gateway update</code> (Windows) on the
              gateway
            </b>
          )}
        </li>
        {open && <Details g={g} />}
      </ul>
    </details>
  )
}

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
