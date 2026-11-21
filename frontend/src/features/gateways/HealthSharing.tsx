import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { setTelemetry, type Gateway } from './api'
import { toAppError } from '../../errors'
import { switchOutcome, telemetryView, type Level } from './telemetry'

// Health sharing: the level from the last heartbeat. The gateway's state file is the
// truth, so the switch goes over the tunnel and the card follows the gateway's next
// heartbeat (it sends one at once).
export function HealthSharing({ g, manage }: { g: Gateway; manage: boolean }) {
  const qc = useQueryClient()
  const [tooOld, setTooOld] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [pending, setPending] = useState<Level | null>(null)
  const { label, control, waiting } = telemetryView({
    telemetry: g.telemetry,
    manage,
    tooOld,
    pending,
  })
  if (!label && !control) return null

  async function toggle() {
    setBusy(true)
    setMsg(null)
    const to = g.telemetry === 'full' ? 'off' : 'full'
    try {
      await setTelemetry(g.id, to)
      setPending(to)
      await qc.invalidateQueries({ queryKey: ['gateways'] })
    } catch (e) {
      const o = switchOutcome(toAppError(e))
      if ('tooOld' in o) setTooOld(true)
      else setMsg(o.msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <p className="meta muted no-tv" data-telemetry>
      {label && <>Health sharing: {label}. </>}
      {control === 'switch' && (
        <button type="button" disabled={busy || waiting} onClick={toggle}>
          {g.telemetry === 'full' ? 'Turn off' : 'Turn on'}
        </button>
      )}
      {control === 'update' && (
        <>
          Update the gateway to change this here, or run{' '}
          <code>gateway telemetry full</code> (or <code>off</code>) on it.
        </>
      )}
      {msg && <span role="alert"> {msg}</span>}
    </p>
  )
}
