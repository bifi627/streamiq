import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { authed } from '../../api'
import { toAppError } from '../../errors'
import { ErrorView, State } from '../../ErrorView'
import { arrowFocus } from '../../focus'
import {
  byGateway,
  byUse,
  data,
  duration,
  gatewayLabel,
  gatewaysIn,
  route,
  throughput,
  use,
  when,
  type TunnelRow,
} from './tunnels'

// The signed-in user's own tunnels in this household: the last 30 days, ≤ 200.
export function Activity() {
  const q = useQuery({
    queryKey: ['tunnels'],
    queryFn: () => authed<TunnelRow[]>('/tunnels'),
  })
  const [gateway, setGateway] = useState('')
  const [all, setAll] = useState(false)
  const rows = byUse(byGateway(q.data ?? [], gateway), all)
  const choices = gatewaysIn(q.data ?? [])

  return (
    <section className="settings activity" onKeyDown={arrowFocus}>
      <div className="head">
        <h1>Activity</h1>
        <p className="muted">Your connections to this household's gateways.</p>
      </div>
      {q.error && <ErrorView error={toAppError(q.error)} />}
      {q.isPending && <p role="status">Loading…</p>}
      {q.data?.length === 0 && (
        <State icon="empty" title="No tunnels in the last 30 days." />
      )}
      {!!q.data?.length && (
        <>
          <select
            aria-label="Gateway"
            value={gateway}
            onChange={(e) => setGateway(e.target.value)}
          >
            <option value="">All gateways</option>
            {choices.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <label>
            <input
              type="checkbox"
              checked={all}
              onChange={(e) => setAll(e.target.checked)}
            />{' '}
            Show management and diagnostics connections
          </label>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Gateway</th>
                  <th>Use</th>
                  <th>Route</th>
                  <th>Duration</th>
                  <th>Data</th>
                  <th>Throughput</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>{when(t)}</td>
                    <td>{gatewayLabel(t)}</td>
                    <td>{use(t)}</td>
                    <td>{route(t)}</td>
                    <td>{duration(t)}</td>
                    <td>{data(t)}</td>
                    <td>{throughput(t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted meta">
            Showing the last 30 days (up to 200 tunnels).
          </p>
        </>
      )}
    </section>
  )
}
