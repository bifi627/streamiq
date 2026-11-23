import { memberLabel, shownTunnels, type SummaryRow } from './household'
import { bytes } from './tunnels'

import type { Member } from '../../generated/members'

export function MemberSelect(p: {
  value: string
  onChange: (userId: string) => void
  me: string | undefined
  others: Member[]
  names: Map<string, string> | undefined
}) {
  return (
    <select
      aria-label="Member"
      value={p.value}
      onChange={(e) => p.onChange(e.target.value)}
    >
      <option value="">Everyone</option>
      <option value={p.me}>Me</option>
      {p.others.map((m) => (
        <option key={m.userId} value={m.userId}>
          {p.names?.get(m.userId)}
        </option>
      ))}
    </select>
  )
}

// Admin only: per member over the last 30 days; the count follows the checkbox.
export function HouseholdSummary(p: {
  rows: SummaryRow[]
  names: Map<string, string> | undefined
  all: boolean
}) {
  if (!p.rows.length) return null
  return (
    <div className="table-scroll">
      <table aria-label="Members' activity">
        <thead>
          <tr>
            <th>Member</th>
            <th>Tunnels</th>
            <th>Failures</th>
            <th>Relayed data</th>
          </tr>
        </thead>
        <tbody>
          {p.rows.map((s) => (
            <tr key={s.userId}>
              <td>{memberLabel(s.userId, p.names)}</td>
              <td>{shownTunnels(s, p.all).toLocaleString()}</td>
              <td>{s.failed.toLocaleString()}</td>
              <td>{bytes(s.relayedBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
