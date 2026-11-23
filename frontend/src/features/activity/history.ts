import type { Gateway } from '../../generated/gateways'
import type { Summary, Tunnel } from '../../generated/history'
import type { TunnelRow } from './tunnels'

/** One gateway's history; without tunnels it wasn't available. */
export type Fetched = {
  gateway: Gateway
  tunnels?: Tunnel[]
  summary?: Summary[]
}

export type History = {
  rows: TunnelRow[]
  summary: Summary[]
  /** The gateways whose history couldn't be read. */
  unavailable: { id: string; name: string }[]
}

/** Only a gateway that is online and paired with this browser is asked. */
export const askable = (g: Gateway, paired: boolean) => g.online && paired

/** Every gateway's rows, newest first; the summaries added up per user. */
export function merge(fetched: Fetched[]): History {
  const rows: TunnelRow[] = []
  const users = new Map<string, Summary>()
  const unavailable: History['unavailable'] = []
  for (const { gateway: g, tunnels, summary } of fetched) {
    if (!tunnels) {
      unavailable.push({ id: g.id, name: g.name ?? 'Unnamed gateway' })
      continue
    }
    for (const t of tunnels)
      rows.push({
        ...t,
        userId: t.userId ?? undefined,
        gatewayId: g.id,
        gatewayName: g.name,
      })
    for (const s of summary ?? []) {
      const u = users.get(s.userId)
      users.set(
        s.userId,
        u
          ? {
              userId: s.userId,
              tunnels: u.tunnels + s.tunnels,
              hidden: u.hidden + s.hidden,
              failed: u.failed + s.failed,
              relayedBytes: u.relayedBytes + s.relayedBytes,
            }
          : s,
      )
    }
  }
  rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  const summary = [...users.values()].sort((a, b) => b.tunnels - a.tunnels)
  return { rows, summary, unavailable }
}
