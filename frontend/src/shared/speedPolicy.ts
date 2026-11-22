// When the throughput test (speed.ts) sends bursts: the per-device interval
// setting, the cached reading and a real connection switch.

/** Settings' "Measure connection speed": the cache time, or never. */
export type Every = '30m' | '2h' | '1d' | 'off'
export const DEFAULT_EVERY: Every = '2h'
const EVERY_MS = { '30m': 30 * 60_000, '2h': 2 * 3_600_000, '1d': 86_400_000 }

export const toEvery = (v: string | null): Every =>
  v === '30m' || v === '2h' || v === '1d' || v === 'off' ? v : DEFAULT_EVERY

/** A stored measurement; `at` (ms since epoch) is 0 for a value stored
 * before readings had a time: always stale. */
export type Reading = { mbps: number; at: number }

export function parseReading(v: string | null): Reading | undefined {
  if (!v) return undefined
  try {
    const r: unknown = JSON.parse(v)
    if (typeof r === 'number') return r > 0 ? { mbps: r, at: 0 } : undefined
    if (r && typeof r === 'object') {
      const { mbps, at } = r as Record<string, unknown>
      if (typeof mbps === 'number' && mbps > 0 && typeof at === 'number')
        return { mbps, at }
    }
  } catch {
    // not JSON: no reading
  }
  return undefined
}

export type Plan = 'measure' | 'cache' | 'skip'

/** Auto playback: send bursts, use the reading, or (setting Off, nothing
 * cached) go without. Off never measures, whatever the reading's age. */
export function plan(every: Every, r: Reading | undefined, now: number): Plan {
  if (every === 'off') return r ? 'cache' : 'skip'
  return r && now - r.at < EVERY_MS[every] ? 'cache' : 'measure'
}

/** A `change` event is a real switch only when the connection type differs
 * from the last run's; none yet = nothing to re-measure. */
export const switched = (last: string | undefined, now: string) =>
  last !== undefined && last !== now

/** The diagnostics log's age of a cached reading. */
export function age(ms: number) {
  const min = Math.round(ms / 60_000)
  return min < 120 ? `${min} min old` : `${Math.round(min / 60)} h old`
}
