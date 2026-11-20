import { useEffect, useState } from 'react'
import { getStatus, type Gateway, type GatewayStatus } from './api'
import { toAppError } from '../../errors'
import { detailsMessage } from './list'
import { loadHints, loadLine } from './host'

const tokenText = {
  ok: 'token set',
  missing: 'token missing: open the gateway page and Connect Jellyfin',
}

// Liveness from the heartbeat (works unpaired); the details from the gateway API
// over the tunnel, which needs this browser paired.
export function StatusDetails({ g }: { g: Gateway }) {
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

const transcodingText: Record<string, string> = {
  nvenc: 'GPU (nvenc)',
  none: 'CPU',
  unmanaged: 'not managed by StreamIQ',
}

const LOAD_REFRESH = 10_000 // the gateway's CPU sampling interval

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

// Without `host`: stale load misleads.
function writeCache(id: string, s: GatewayStatus) {
  try {
    localStorage.setItem(
      cacheKey(id),
      JSON.stringify({
        at: new Date().toISOString(),
        s: { ...s, host: undefined },
      }),
    )
  } catch {
    // ignore: the live view still works
  }
}

// The gateway's shared tunnel session while online, released once the
// status is in, asked again every LOAD_REFRESH for the live load; offline,
// the cached last response, dated.
function Details({ g }: { g: Gateway }) {
  const [s, setS] = useState<GatewayStatus | null>(null)
  const [msg, setMsg] = useState('checking…')
  useEffect(() => {
    if (!g.online) return
    let live = true
    const ask = () =>
      getStatus(g.id)
        .then((r) => {
          writeCache(g.id, r)
          if (live) setS(r)
        })
        .catch((x) => {
          if (live) setMsg(detailsMessage(toAppError(x)))
        })
    void ask()
    const t = setInterval(ask, LOAD_REFRESH)
    return () => {
      live = false
      clearInterval(t)
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
      <Load s={s} />
    </>
  )
}

function Load({ s }: { s: GatewayStatus }) {
  const line = loadLine(s.host)
  if (!line) return null
  return (
    <li>
      {line}
      {loadHints(s.host).map((h) => (
        <b key={h}> · {h}</b>
      ))}
    </li>
  )
}
