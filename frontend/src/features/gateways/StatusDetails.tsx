import { useState } from 'react'
import {
  readCache,
  useGatewayStatus,
  type Gateway,
  type GatewayStatus,
} from './api'
import { toAppError } from '../../shared/errors'
import { detailsMessage } from './list'
import { loadHints, loadLine } from './host'
import { RelaySetting } from './RelaySetting'
import { Tile } from '../../shared/Tile'

const tokenText = {
  ok: 'token set',
  missing: 'token missing: open the gateway page and Connect Jellyfin',
}

// Liveness from the heartbeat (works unpaired); the details from the gateway API
// over the tunnel, which needs this browser paired. manage: the relay switch.
export function StatusDetails({ g, manage }: { g: Gateway; manage: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <Tile title="Status" onOpen={setOpen}>
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
        {g.lanUrl && (
          <li>
            <a href={g.lanUrl} target="_blank" rel="noreferrer">
              Gateway page
            </a>{' '}
            (on your home network)
          </li>
        )}
        {open && <Details g={g} />}
      </ul>
      <h3>Connection</h3>
      <RelaySetting g={g} manage={manage} />
    </Tile>
  )
}

const transcodingText: Record<string, string> = {
  nvenc: 'GPU (nvenc)',
  none: 'CPU',
  unmanaged: 'not managed by StreamIQ',
}

// The gateway's shared tunnel session while online, released once the
// status is in, asked again for the live load (nextAsk); offline, the cached
// last response, dated.
function Details({ g }: { g: Gateway }) {
  const q = useGatewayStatus(g.id, g.online)
  // An error hides the last reading: one that can't be refreshed would pass for live.
  const s = q.isError ? null : q.data
  const msg = q.isError ? detailsMessage(toAppError(q.error)) : 'checking…'

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
