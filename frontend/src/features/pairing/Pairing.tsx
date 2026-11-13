import { useState } from 'react'
import { connect } from './connect'
import { AppError, toAppError } from '../../errors'
import { ErrorView } from '../../ErrorView'
import { tunnelFetch } from '../../tunnel'

// Pair this browser with an online gateway (flow 2), or open a pinned connection
// and tunnel one request through it ("Test connection": a cheap diagnostic).
export function Pairing({
  gatewayId,
  lanUrl,
  onPaired,
}: {
  gatewayId: string
  lanUrl: string | null
  /** After a successful pairing (not after Test connection). */
  onPaired?: () => void
}) {
  const [code, setCode] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [err, setErr] = useState<AppError | null>(null)

  async function run(pair: boolean) {
    setCode(null)
    setErr(null)
    setStatus(pair ? 'Connecting…' : 'Connecting (pinned)…')
    try {
      const s = await connect(gatewayId, pair ? setCode : undefined)
      setCode(null)
      setStatus('Connected · tunneling GET /System/Info/Public…')
      const r = await tunnelFetch(s.pc, '/System/Info/Public')
      setStatus(
        `Tunnel OK · HTTP ${r.status} · ${new TextDecoder().decode(r.body).slice(0, 120)}`,
      )
      s.close()
      if (pair) onPaired?.()
    } catch (e) {
      setCode(null)
      setStatus(null)
      setErr(toAppError(e))
    }
  }

  return (
    <div style={{ marginLeft: '1.5rem' }}>
      <button type="button" onClick={() => run(true)}>
        Pair this browser
      </button>{' '}
      <button type="button" onClick={() => run(false)}>
        Test connection
      </button>
      {code && (
        <p>
          Code{' '}
          <b style={{ fontSize: '1.6em', letterSpacing: '0.1em' }}>{code}</b> —
          open the{' '}
          {lanUrl ? (
            <a href={lanUrl} target="_blank" rel="noreferrer">
              gateway page
            </a>
          ) : (
            'gateway page'
          )}{' '}
          on your home network and approve if it shows the same code.
        </p>
      )}
      {status && <p style={{ color: '#666' }}>{status}</p>}
      {err && <ErrorView error={err} onRetry={() => run(false)} pair={null} />}
    </div>
  )
}
