import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toAppError } from '../../shared/errors'
import { getHealth, type Gateway } from './api'
import {
  dailyPeaks,
  historyGap,
  historyMessage,
  incidents,
  span,
  versionChanges,
  type HealthRow,
} from './health'
import { Tile } from './Tile'

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
  gap: 'No data (gateway offline)',
}

// The gateway's own health history, over the tunnel (paired, online). Asked
// only while open.
export function HealthHistory({ g, paired }: { g: Gateway; paired: boolean }) {
  const [open, setOpen] = useState(false)
  const gap = historyGap(g.online, paired)
  return (
    <Tile title="Health" onOpen={setOpen}>
      <p className="muted">The last 7 days, from the gateway.</p>
      {open && (gap ? <p className="muted">{gap}</p> : <History g={g} />)}
    </Tile>
  )
}

function History({ g }: { g: Gateway }) {
  const q = useQuery({
    queryKey: ['gatewayHealth', g.id],
    queryFn: () => getHealth(g.id),
    retry: false, // each try opens a tunnel
    refetchOnWindowFocus: false,
  })
  if (q.isError)
    return <p role="alert">{historyMessage(toAppError(q.error))}</p>
  if (!q.data) return <p className="muted">Loading…</p>
  if (!q.data.length) return <p className="muted">No health data yet.</p>
  // The fetch's time, not the render's: the rows don't move while the page polls.
  const now = q.dataUpdatedAt
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
