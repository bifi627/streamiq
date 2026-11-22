import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { setTelemetry, type Gateway } from './api'
import { describe, toAppError } from '../../shared/errors'
import { telemetryView, type Level } from './telemetry'

// Health sharing: the level from the last heartbeat. The gateway's state file is the
// truth, so the switch goes over the tunnel and the card follows the gateway's next
// heartbeat (it sends one at once).
export function HealthSharing({ g, manage }: { g: Gateway; manage: boolean }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [pending, setPending] = useState<Level | null>(null)
  const { label, toggle, waiting } = telemetryView({
    telemetry: g.telemetry,
    manage,
    pending,
  })
  // Reached: forget it, or a later change from elsewhere reads as waiting.
  if (pending && pending === g.telemetry) setPending(null)
  if (!label) return null

  async function flip() {
    setBusy(true)
    setMsg(null)
    const to = g.telemetry === 'full' ? 'off' : 'full'
    try {
      await setTelemetry(g.id, to)
      setPending(to)
      await qc.invalidateQueries({ queryKey: ['gateways'] })
    } catch (e) {
      setMsg(describe(toAppError(e)).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <p className="meta muted no-tv">
      Health sharing: {label}.{' '}
      {toggle && (
        <button type="button" disabled={busy || waiting} onClick={flip}>
          {g.telemetry === 'full' ? 'Turn off' : 'Turn on'}
        </button>
      )}
      {msg && <span role="alert"> {msg}</span>}
    </p>
  )
}
