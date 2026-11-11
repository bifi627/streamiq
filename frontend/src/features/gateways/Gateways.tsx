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
import { connect, NotPaired, type Session } from '../pairing/connect'
import { tunnelJson } from '../../tunnel'
import { useNavigate } from '@tanstack/react-router'

// Gateways list + "Add gateway" (onboarding flow 1). Polls so a freshly installed
// gateway shows up, and online/offline stays current. ponytail: 5s poll, push
// updates over a socket if the list ever gets big.
export function Gateways() {
  const [gateways, setGateways] = useState<Gateway[]>([])
  const [install, setInstall] = useState<Install | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    const load = () =>
      getGateways()
        .then((d) => {
          setGateways(d)
          setErr(null)
        })
        .catch((e: Error) => setErr(e.message))
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
      setGateways((gs) => gs.filter((g) => g.id !== d.id))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function addGateway() {
    try {
      setInstall(await createEnrollmentToken())
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section>
      <h2>Gateways</h2>
      {err && <p style={{ color: 'crimson' }}>{err}</p>}
      {gateways.length === 0 ? (
        !err && <p>No gateways yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {gateways.map((d) => (
            <li key={d.id}>
              <span style={{ color: d.online ? 'green' : '#888' }}>●</span>{' '}
              {d.name ?? 'gateway'}{' '}
              <code style={{ fontSize: '0.8em', color: '#888' }}>{d.id}</code> —{' '}
              {d.online ? 'online' : 'offline'}
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
              <button type="button" onClick={() => remove(d)}>
                Remove
              </button>
              <StatusDetails g={d} />
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={addGateway}>
        Add gateway
      </button>
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

// Read-only status from the gateway's heartbeat (#129). Offline: last known
// values, dated. No tunnel needed, so it works before this browser is paired;
// only the Transcoding line comes from the gateway API over the tunnel.
function StatusDetails({ g }: { g: Gateway }) {
  const [open, setOpen] = useState(false)
  const s: GatewayStatus | null = g.status
  const at = (iso: string) => new Date(iso).toLocaleString()
  if (!s)
    return (
      <details>
        <summary>Status</summary>
        <p>
          No status yet
          {g.version ? ' (gateway too old to report it: update it)' : ''}.
        </p>
      </details>
    )
  const jf = s.jellyfin
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Status</summary>
      {!g.online && g.lastSeenAt && <p>Offline. As of {at(g.lastSeenAt)}:</p>}
      <ul>
        <li>
          StreamIQ:{' '}
          {g.online && g.lastSeenAt
            ? `connected, last heartbeat ${new Date(g.lastSeenAt).toLocaleTimeString()}`
            : 'not connected'}
        </li>
        <li>
          Version {g.version ?? 'unknown'}
          {s.update && (
            <b>
              {' '}
              · update available: {s.update}, run{' '}
              <code>
                {s.os === 'windows' ? 'gateway update' : 'install.sh'}
              </code>{' '}
              on the gateway
            </b>
          )}
        </li>
        {(s.os || s.startedAt) && (
          <li>
            {s.os && `${s.os}/${s.arch ?? '?'}`}
            {s.os && s.startedAt && ' · '}
            {s.startedAt && `running since ${at(s.startedAt)}`}
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
        {open && <Transcoding g={g} />}
      </ul>
    </details>
  )
}

const transcodingText: Record<string, string> = {
  nvenc: 'GPU (nvenc)',
  none: 'CPU',
  unmanaged: 'not managed by StreamIQ',
}

// From the gateway API over the tunnel (#146), so it needs this browser paired
// and the gateway online. One short session per opening of the details.
function Transcoding({ g }: { g: Gateway }) {
  const [text, setText] = useState('checking…')
  useEffect(() => {
    if (!g.online) return
    let live = true
    let sess: Session | undefined
    connect(g.id)
      .then((x) => {
        sess = x
        return tunnelJson<{ transcoding: string }>(x.pc, '/streamiq/status')
      })
      .then(
        (r) => live && setText(transcodingText[r.transcoding] ?? r.transcoding),
      )
      .catch(
        (e: Error) =>
          live &&
          setText(
            e instanceof NotPaired
              ? 'pair this browser to see it'
              : e.message.includes('HTTP 404')
                ? 'gateway too old to report it: update it'
                : `unavailable (${e.message})`,
          ),
      )
      .finally(() => sess?.close())
    return () => {
      live = false
    }
  }, [g.id, g.online])
  return (
    <li>Transcoding: {g.online ? text : 'gateway offline, not available'}</li>
  )
}
