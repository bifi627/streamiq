import type { Tunnel } from '../../generated/tunnels'

// The generated type says null; the API leaves userId out instead (household scope only;
// absent there = a deleted account).
export type TunnelRow = Omit<Tunnel, 'userId'> & { userId?: string }

const USES: Record<string, string> = {
  playback: 'Playback',
  browsing: 'Browsing',
  diagnostics: 'Diagnostics',
  management: 'Management',
}

/** Unknown words (a newer gateway's) show as they are. */
export const use = (t: TunnelRow) => (t.use ? (USES[t.use] ?? t.use) : '—')

const REASONS: Record<string, string> = {
  'ice failed': "Couldn't connect: the network blocked it",
  unpaired: "This browser isn't paired",
  'ended before auth': 'Closed before it connected',
  'gateway busy': 'The gateway was busy',
  'not authenticated within 30s': 'Closed: no sign-in in time',
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

/** "6 min 40 sec"; the small part only when it isn't 0. */
export function pair(big: string, n: number, small: string, m: number): string {
  const head = unit(big).format(n)
  return m ? `${head} ${unit(small).format(m)}` : head
}

export function duration(t: TunnelRow): string {
  let ms: number
  if (t.activeMs !== null) ms = t.activeMs
  else if (!t.endedAt) return 'Ongoing'
  else ms = Date.parse(t.endedAt) - Date.parse(t.createdAt)
  // ms below 1 s, tenths below 10 s, then whole seconds; from a minute on
  // two units, the larger one first. 999.5 / 9950: where rounding would
  // reach the next step.
  if (ms < 999.5) return unit('millisecond').format(ms)
  if (ms < 9950) return unit('second', 1).format(ms / 1000)
  const s = Math.round(ms / 1000)
  if (s < 60) return unit('second').format(s)
  return s < 3600
    ? pair('minute', Math.floor(s / 60), 'second', s % 60)
    : pair('hour', Math.floor(s / 3600), 'minute', Math.floor(s / 60) % 60)
}

export function data(t: TunnelRow): string {
  if (t.bytesSent === null) return '—'
  return bytes(t.bytesSent + (t.bytesReceived ?? 0))
}

export const bytes = (n: number) =>
  scaled(n, ['byte', 'kilobyte', 'megabyte', 'gigabyte'], 1000)

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

const HIDDEN = new Set(['management', 'diagnostics'])

/** Without `all`: no management or diagnostics rows, unless they failed. */
export const byUse = (rows: TunnelRow[], all: boolean) =>
  all ? rows : rows.filter((t) => t.failure || !HIDDEN.has(t.use ?? ''))
