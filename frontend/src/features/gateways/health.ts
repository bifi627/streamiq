import { pair } from '../activity/tunnels.ts'

// GET /api/gateways/{id}/health: the last 7 days of `gateway_health`, oldest
// first, led by the latest row before them (docs/protocol.md). Null = not sent.
export type HealthRow = {
  at: string
  jellyfinReachable: boolean | null
  jellyfinVersion: string | null
  gatewayVersion: string | null
  tunnels: number | null
  transcodes: number | null
  cpu: number | null
  memory: number | null
}

export const WINDOW_MS = 7 * 24 * 3600_000
// Rows come at least every 5 min while sharing is on: more than 10 min
// without one means the gateway was offline or sharing was off.
export const GAP_MS = 10 * 60_000

// Epoch ms; to null = still going on.
export type Incident = {
  kind: 'jellyfin' | 'gap'
  from: number
  to: number | null
}

// Newest first, clipped to the window (the row before it only sets the state
// the window starts in).
export function incidents(rows: HealthRow[], now: number): Incident[] {
  const start = now - WINDOW_MS
  const out: Incident[] = []
  let down: number | null = null
  const endDown = (to: number | null) => {
    if (down !== null) out.push({ kind: 'jellyfin', from: down, to })
    down = null
  }
  rows.forEach((r, i) => {
    const at = Date.parse(r.at)
    if (r.jellyfinReachable === false && down === null) down = at
    if (r.jellyfinReachable === true) endDown(at)
    const next = i + 1 < rows.length ? Date.parse(rows[i + 1].at) : now
    if (next - at > GAP_MS) {
      endDown(at)
      out.push({ kind: 'gap', from: at, to: i + 1 < rows.length ? next : null })
    }
  })
  endDown(null)
  return out
    .filter((x) => x.to === null || x.to > start)
    .map((x) => ({ ...x, from: Math.max(x.from, start) }))
    .sort((a, b) => b.from - a.from)
}

export type VersionChange = {
  at: number
  what: 'Jellyfin' | 'Gateway'
  from: string
  to: string
}

// Newest first. A null version (an older row) is no change.
export function versionChanges(
  rows: HealthRow[],
  now: number,
): VersionChange[] {
  const start = now - WINDOW_MS
  const out: VersionChange[] = []
  const last = {
    Jellyfin: null as string | null,
    Gateway: null as string | null,
  }
  for (const r of rows) {
    const at = Date.parse(r.at)
    for (const [what, v] of [
      ['Jellyfin', r.jellyfinVersion],
      ['Gateway', r.gatewayVersion],
    ] as const) {
      if (v === null) continue
      const from = last[what]
      if (from !== null && from !== v && at >= start)
        out.push({ at, what, from, to: v })
      last[what] = v
    }
  }
  return out.reverse()
}

type Peaks = {
  tunnels: number | null
  transcodes: number | null
  cpu: number | null
  memory: number | null
}
export type DayPeaks = { day: Date } & Peaks

const FIELDS = ['tunnels', 'transcodes', 'cpu', 'memory'] as const

// One entry per local day of the window, today first; the highest of each
// field among that day's rows, null = no value that day.
export function dailyPeaks(rows: HealthRow[], now: number): DayPeaks[] {
  const start = now - WINDOW_MS
  const days: DayPeaks[] = []
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  while (day.getTime() + 24 * 3600_000 > start) {
    days.push({
      day: new Date(day),
      tunnels: null,
      transcodes: null,
      cpu: null,
      memory: null,
    })
    day.setDate(day.getDate() - 1) // local days: 23 or 25 h around DST
  }
  for (const r of rows) {
    const at = new Date(r.at)
    if (at.getTime() < start) continue
    const d = days.find((x) => x.day <= at)
    if (!d) continue
    for (const f of FIELDS) {
      const v = r[f]
      if (v !== null && (d[f] === null || v > d[f])) d[f] = v
    }
  }
  return days
}

const minutes = new Intl.NumberFormat(undefined, {
  style: 'unit',
  unit: 'minute',
  unitDisplay: 'short',
})

// "4 min", "2 hr 5 min", "3 days 4 hr".
export function span(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) return minutes.format(m)
  if (m < 24 * 60) return pair('hour', Math.floor(m / 60), 'minute', m % 60)
  return pair('day', Math.floor(m / 1440), 'hour', Math.floor(m / 60) % 24)
}
