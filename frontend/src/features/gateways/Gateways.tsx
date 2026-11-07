import { useEffect, useState } from 'react'
import {
  createEnrollmentToken,
  getGateways,
  removeGateway,
  type Gateway,
  type Install,
} from './api'
import { Pairing } from '../pairing/Pairing'
import { Library } from '../library/Library'

// Gateways list + "Add gateway" (onboarding flow 1). Polls so a freshly installed
// gateway shows up, and online/offline stays current. ponytail: 5s poll, push
// updates over a socket if the list ever gets big.
export function Gateways() {
  const [gateways, setGateways] = useState<Gateway[]>([])
  const [install, setInstall] = useState<Install | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [opened, setOpened] = useState<string | null>(null)

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

  if (opened)
    return <Library gatewayId={opened} onClose={() => setOpened(null)} />

  return (
    <section>
      <h2>Gateways</h2>
      {gateways.length === 0 ? (
        <p>No gateways yet.</p>
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
                  <button type="button" onClick={() => setOpened(d.id)}>
                    Open
                  </button>
                  <Pairing gatewayId={d.id} lanUrl={d.lanUrl} />
                </>
              )}{' '}
              <button type="button" onClick={() => remove(d)}>
                Remove
              </button>
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
      {err && <p style={{ color: 'crimson' }}>{err}</p>}
    </section>
  )
}
