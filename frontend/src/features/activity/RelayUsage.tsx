import { useQuery } from '@tanstack/react-query'
import { authed } from '../../shared/api'
import { relayLabel } from './relay'
import { bytes } from './tunnels'
import type { Usage } from '../../generated/relayusage'

// Admin only: from the API, so it shows while the gateways are offline.
export function RelayUsage() {
  const q = useQuery({
    queryKey: ['relay-usage'],
    queryFn: () => authed<Usage[]>('/relay-usage'),
  })
  if (!q.data?.length) return null
  return (
    <>
      <h2>Relayed through StreamIQ</h2>
      <div className="table-scroll">
        <table aria-label="Relayed through StreamIQ">
          <thead>
            <tr>
              <th>Gateway</th>
              <th>This month</th>
              <th>Last month</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((u) => (
              <tr key={u.gatewayId}>
                <td>{relayLabel(u)}</td>
                <td>{bytes(u.thisMonth)}</td>
                <td>{bytes(u.lastMonth)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted meta">
        Connections your network couldn't make directly. The numbers can be a
        day behind.
      </p>
    </>
  )
}
