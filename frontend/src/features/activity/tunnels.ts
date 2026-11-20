// GET /api/tunnels: the signed-in user's own tunnels in this household.
export type TunnelRow = {
  id: string
  createdAt: string
  endedAt: string | null // null = still open
  gatewayId: string
  gatewayName: string | null
  relay: boolean
  ipv6: boolean
  bytesSent: number | null // null = no gateway report (yet)
  bytesReceived: number | null
  throughputKbps: number | null
  failure: string | null
}

const REASONS: Record<string, string> = {
  'ice failed': "Couldn't connect: the network blocked it",
  unpaired: "This browser isn't paired",
  'ended before auth': 'Closed before it connected',
}

export function route(t: TunnelRow): string {
  if (t.failure) return `Failed: ${REASONS[t.failure] ?? t.failure}`
  if (t.bytesSent === null) return 'Unknown'
  return (t.relay ? 'Relayed' : 'Direct') + (t.ipv6 ? ' · IPv6' : '')
}

const unit = (u: string, max = 0) =>
  new Intl.NumberFormat(undefined, {
    style: 'unit',
    unit: u,
    unitDisplay: 'short',
    maximumFractionDigits: max,
  })

// The largest unit that keeps the number ≥ 1 (1000-based, like network speeds).
// 0.9995: a value that would round up to `step` moves to the next unit already.
function scaled(n: number, units: string[], step: number): string {
  let i = 0
  while (n >= step * 0.9995 && i < units.length - 1) {
    n /= step
    i++
  }
  return unit(units[i], i ? 1 : 0).format(n)
}

export function duration(t: TunnelRow): string {
  if (!t.endedAt) return 'Ongoing'
  const s = (Date.parse(t.endedAt) - Date.parse(t.createdAt)) / 1000
  // Switch units where the rounded number would reach 60.
  if (s < 59.5) return unit('second').format(s)
  if (s < 3570) return unit('minute').format(s / 60)
  return unit('hour', 1).format(s / 3600)
}

export function data(t: TunnelRow): string {
  if (t.bytesSent === null) return '—'
  const bytes = t.bytesSent + (t.bytesReceived ?? 0)
  return scaled(bytes, ['byte', 'kilobyte', 'megabyte', 'gigabyte'], 1000)
}

export function throughput(t: TunnelRow): string {
  if (t.throughputKbps === null) return '—'
  return scaled(
    t.throughputKbps,
    ['kilobit-per-second', 'megabit-per-second', 'gigabit-per-second'],
    1000,
  )
}

export const when = (t: TunnelRow) =>
  new Date(t.createdAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

export const gatewayLabel = (t: TunnelRow) => t.gatewayName ?? 'Unnamed gateway'

/** The filter's choices: each gateway in the rows once, in first-seen order. */
export function gatewaysIn(rows: TunnelRow[]): { id: string; name: string }[] {
  const seen = new Map<string, string>()
  for (const t of rows)
    if (!seen.has(t.gatewayId)) seen.set(t.gatewayId, gatewayLabel(t))
  return [...seen].map(([id, name]) => ({ id, name }))
}

/** The rows of one gateway; '' = all. */
export const byGateway = (rows: TunnelRow[], gatewayId: string) =>
  gatewayId ? rows.filter((t) => t.gatewayId === gatewayId) : rows
