import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { setGatewayRelay, type Gateway } from './api'
import { relayMessage, toAppError } from '../../shared/errors'

// The gateway's relay switch: an admin's, over the tunnel (manage), with what off
// costs; everyone else sees only that it is off.
export function RelaySetting({ g, manage }: { g: Gateway; manage: boolean }) {
  const qc = useQueryClient()
  const [error, setError] = useState('')
  if (!manage)
    return g.relayOff ? (
      <p className="meta muted no-tv">Direct connections only (relay off)</p>
    ) : null
  async function toggle(on: boolean) {
    setError('')
    try {
      const relay = await setGatewayRelay(g.id, on)
      // Shown at once; the gateway tells the API with a heartbeat.
      qc.setQueryData<Gateway[]>(['gateways'], (gs) =>
        gs?.map((x) => (x.id === g.id ? { ...x, relayOff: !relay } : x)),
      )
      void qc.invalidateQueries({ queryKey: ['gateways'] })
    } catch (e) {
      setError(relayMessage(toAppError(e)))
    }
  }
  return (
    <div className="relay no-tv">
      <label>
        <input
          type="checkbox"
          checked={!g.relayOff}
          onChange={(e) => toggle(e.target.checked)}
        />{' '}
        Allow the relay (TURN)
      </label>
      <p className="hint muted">
        Off: direct connections only, the stream never passes through the relay.
        Clients behind carrier NAT (most cellular) or a strict NAT can't
        connect.
      </p>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
