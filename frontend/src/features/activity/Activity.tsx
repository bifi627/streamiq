import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toAppError } from '../../shared/errors'
import { ErrorView, State } from '../../shared/ErrorView'
import { flag, setFlag } from '../../shared/diag'
import { useHousehold } from '../households/household'
import { loadHistory } from './api'
import { byMember, memberLabel } from './household'
import { HouseholdSummary, MemberSelect } from './HouseholdSummary'
import { RelayUsage } from './RelayUsage'
import { useMembers } from './useMembers'
import { line } from '../player/summary'
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

// The household details' Activity tile: tunnels in this household, the last
// 30 days, ≤ 200 per gateway, read from each gateway (mounted only once opened): a member's own; an admin's opens on everyone's, with a per-member summary
// and a member filter.
// oxlint-disable-next-line complexity -- render branching; the filters' decisions live in tunnels.ts
export function Activity() {
  const { me, current } = useHousehold()
  const admin = current?.role === 'admin'
  const q = useQuery({
    queryKey: ['tunnels', admin],
    queryFn: () => loadHistory(admin),
    retry: false, // each try opens a tunnel per gateway
    refetchOnWindowFocus: false,
  })
  const tunnels = q.data?.rows
  const { names, others } = useMembers(admin, me?.userId)
  const [gateway, setGateway] = useState('')
  const [member, setMember] = useState('')
  const [all, setAll] = useState(() => flag('activityAll'))
  const rows = byUse(byMember(byGateway(tunnels ?? [], gateway), member), all)

  return (
    <div className="activity">
      <p>
        {admin ? "Everyone's" : 'Your'} connections to this household's
        gateways.
      </p>
      {q.error && <ErrorView error={toAppError(q.error)} />}
      {q.data?.unavailable.map((g) => (
        <p key={g.id} className="muted">
          {g.name}: history unavailable
        </p>
      ))}
      {admin && q.data && (
        <HouseholdSummary rows={q.data.summary} names={names} all={all} />
      )}
      {admin && <RelayUsage />}
      {q.isPending && <p role="status">Loading…</p>}
      {tunnels?.length === 0 && !q.data?.unavailable.length && (
        <State icon="empty" title="No tunnels in the last 30 days." />
      )}
      {!!tunnels?.length && (
        <>
          <div className="filters">
            <GatewaySelect
              rows={tunnels}
              value={gateway}
              onChange={setGateway}
            />
            {admin && (
              <MemberSelect
                value={member}
                onChange={setMember}
                me={me?.userId}
                others={others}
                names={names}
              />
            )}
          </div>
          <label>
            <input
              type="checkbox"
              checked={all}
              onChange={(e) => {
                setAll(e.target.checked)
                setFlag('activityAll', e.target.checked)
              }}
            />{' '}
            Show management and diagnostics connections
          </label>
          <TunnelTable rows={rows} admin={admin} names={names} />
          {rows.length === 0 && (
            <p className="muted">No connections to show.</p>
          )}
          <p className="muted meta">
            Showing the last 30 days (up to 200 tunnels per gateway).
          </p>
        </>
      )}
    </div>
  )
}

function TunnelTable({
  rows,
  admin,
  names,
}: {
  rows: TunnelRow[]
  admin: boolean
  names: Map<string, string> | undefined
}) {
  return (
    <div className="table-scroll">
      <table aria-label="Tunnels">
        <thead>
          <tr>
            <th>When</th>
            {admin && <th>Member</th>}
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
            <Fragment key={t.id}>
              <tr>
                <td>{when(t)}</td>
                {admin && <td>{memberLabel(t.userId, names)}</td>}
                <td>{gatewayLabel(t)}</td>
                <td>{use(t)}</td>
                <td>{route(t)}</td>
                <td>{duration(t)}</td>
                <td>{data(t)}</td>
                <td>{throughput(t)}</td>
              </tr>
              {t.playbacks?.map((p, i) => (
                <tr key={i} className="playback">
                  <td colSpan={admin ? 8 : 7}>{line(p)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function GatewaySelect(p: {
  rows: TunnelRow[]
  value: string
  onChange: (gatewayId: string) => void
}) {
  return (
    <select
      aria-label="Gateway"
      value={p.value}
      onChange={(e) => p.onChange(e.target.value)}
    >
      <option value="">All gateways</option>
      {gatewaysIn(p.rows).map((g) => (
        <option key={g.id} value={g.id}>
          {g.name}
        </option>
      ))}
    </select>
  )
}
