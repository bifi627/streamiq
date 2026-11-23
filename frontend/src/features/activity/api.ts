import { getGateways, viaTunnel } from '../gateways/api'
import { getPin } from '../pairing/store'
import { event } from '../../shared/diag'
import { askable, merge, type Fetched } from './history'
import { tunnelsPath } from './household'
import type { Summary, Tunnel } from '../../generated/history'

// Activity reads each gateway's own history over the tunnel: the API keeps none
// (docs/architecture.md, "Tunnel telemetry"). A gateway that can't be asked or
// fails is named as unavailable.
export async function loadHistory(admin: boolean) {
  const gateways = await getGateways()
  const fetched = await Promise.all(
    gateways.map(async (g): Promise<Fetched> => {
      const paired = await getPin(g.id).then(
        (p) => !!p,
        () => false,
      )
      if (!askable(g, paired)) return { gateway: g }
      try {
        const tunnels = await viaTunnel<Tunnel[]>(g.id, tunnelsPath(admin))
        const summary = admin
          ? await viaTunnel<Summary[]>(g.id, '/streamiq/tunnels/summary')
          : undefined
        return { gateway: g, tunnels, summary }
      } catch (e) {
        event(`activity: ${g.id}: history unavailable: ${e}`)
        return { gateway: g }
      }
    }),
  )
  return merge(fetched)
}
