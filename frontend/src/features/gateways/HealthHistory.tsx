import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { authed } from '../../api'
import { describe, toAppError } from '../../errors'
import type { Gateway } from './api'
import {
  dailyPeaks,
  incidents,
  span,
  versionChanges,
  type HealthRow,
} from './health'

const at = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
const pct = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 0,
})
const KIND = {
  jellyfin: 'Jellyfin down',
  gap: 'No data (gateway offline or sharing off)',
}

// The stored health history from the API: works offline and unpaired. Asked
// only while open.
export function HealthHistory({ g }: { g: Gateway }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="no-tv" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Health, last 7 days</summary>
      {open && <History g={g} />}
    </details>
  )
}

function History({ g }: { g: Gateway }) {
  const q = useQuery({
    queryKey: ['gatewayHealth', g.id],
    queryFn: () => authed<HealthRow[]>(`/gateways/${g.id}/health`),
  })
  if (q.isError)
    return <p role="alert">{describe(toAppError(q.error)).message}</p>
  if (!q.data) return <p className="muted">Loading…</p>
  if (!q.data.length)
    return (
      <p className="muted">
        {g.telemetry === 'full'
          ? 'No health data yet.'
          : 'Health sharing is off: an admin turns it on above.'}
      </p>
    )
  const now = Date.now()
  return (
    <>
      <Incidents rows={q.data} now={now} />
      <Versions rows={q.data} now={now} />
      <Peaks rows={q.data} now={now} />
    </>
  )
}

type Props = { rows: HealthRow[]; now: number }

function Incidents({ rows, now }: Props) {
  const list = incidents(rows, now)
  return (
    <>
      <h3>Incidents</h3>
      {list.length ? (
        <div className="table-scroll">
          <table aria-label="Incidents">
            <thead>
              <tr>
                <th>What</th>
                <th>From</th>
                <th>To</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {list.map((x) => (
                <tr key={`${x.kind}${x.from}`}>
                  <td>{KIND[x.kind]}</td>
                  <td>{at(x.from)}</td>
                  <td>{x.to === null ? 'still going on' : at(x.to)}</td>
                  <td>{span((x.to ?? now) - x.from)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No incidents.</p>
      )}
    </>
  )
}

function Versions({ rows, now }: Props) {
  const list = versionChanges(rows, now)
  return (
    <>
      <h3>Versions</h3>
      {list.length ? (
        <div className="table-scroll">
          <table aria-label="Version changes">
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>From</th>
                <th>To</th>
              </tr>
            </thead>
            <tbody>
              {list.map((x) => (
                <tr key={`${x.what}${x.at}`}>
                  <td>{at(x.at)}</td>
                  <td>{x.what}</td>
                  <td>{x.from}</td>
                  <td>{x.to}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No version changes.</p>
      )}
    </>
  )
}

const num = (n: number | null) => (n === null ? '' : n.toLocaleString())
const percent = (n: number | null) => (n === null ? '' : pct.format(n / 100))

function Peaks({ rows, now }: Props) {
  return (
    <>
      <h3>Daily peaks</h3>
      <div className="table-scroll">
        <table aria-label="Daily peaks">
          <thead>
            <tr>
              <th>Day</th>
              <th>Tunnels</th>
              <th>Transcodes</th>
              <th>CPU</th>
              <th>Memory</th>
            </tr>
          </thead>
          <tbody>
            {dailyPeaks(rows, now).map((d) => (
              <tr key={d.day.getTime()}>
                <td>
                  {d.day.toLocaleDateString(undefined, { dateStyle: 'medium' })}
                </td>
                <td>{num(d.tunnels)}</td>
                <td>{num(d.transcodes)}</td>
                <td>{percent(d.cpu)}</td>
                <td>{percent(d.memory)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
