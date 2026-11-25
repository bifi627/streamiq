// Gateway → client throughput: a 1 MiB warm-up burst (/streamiq/burst;
// dropped: its read is mostly ramp-up), then 3 bursts sized to last
// ~2 s each at the last read; median in Mbps. Nothing runs until Auto
// playback asks (or /diagnostics tests): a reading younger than the
// "Measure connection speed" interval (speedPolicy.ts) is used from
// localStorage instead, per gateway + direct/relay + connection type.
// A navigator.connection `change` re-runs only when the type switched. Data
// saver: no warm-up and 3 × 1 MiB (~3 MB), not stored (it reads low: ramp-up).
import { event } from './diag'
import { pairInfo } from './stats'
import { tunnelFetch } from './tunnel'
import { burstSize, median } from '../features/player/profile'
import { dataSaverOn, speedEvery } from './settings'
import { age, parseReading, plan, switched, type Reading } from './speedPolicy'

// GET /streamiq/burst: the raw response, so the speed test times it.
const burstOn = (pc: RTCPeerConnection, size: number) =>
  tunnelFetch(pc, `/streamiq/burst?size=${size}`)

const MIB = 1 << 20

type Connection = EventTarget & { type?: string }
const connection = () =>
  (navigator as Navigator & { connection?: Connection }).connection
const type = () => connection()?.type ?? '?'

export type Speed = {
  /** Auto playback: measures unless a reading is recent enough (or the
   * setting is Off); waits at most `wait` ms for a run. Mbps, the stored
   * reading while a run is late, undefined = nothing known. */
  auto: (wait: number) => Promise<number | undefined>
  /** The last reading, never measures (the other qualities). */
  known: () => Promise<number | undefined>
  /** /diagnostics: always a fresh measurement. */
  test: () => Promise<void>
  /** This tunnel's own measurement (telemetry, diagnostics). */
  fresh: () => number | undefined
  error: () => string | undefined
  stop: () => void
}

export function measure(pc: RTCPeerConnection, gatewayId: string): Speed {
  let fresh: number | undefined
  let error: string | undefined
  let running: Promise<void> | undefined
  let lastType: string | undefined
  // This tunnel's newest reading, also a data saver one that isn't stored.
  let mine: { key: string; r: Reading } | undefined

  const current = async () => {
    const p = pairInfo(await pc.getStats())
    const key = `streamiq.speed:${gatewayId}:${p?.relay ? 'relay' : 'direct'}:${type()}`
    if (mine?.key === key) return { key, r: mine.r }
    try {
      return { key, r: parseReading(localStorage.getItem(key)) }
    } catch {
      return { key, r: undefined } // no storage: nothing cached
    }
  }

  const bursts = async (key: string) => {
    const burst = async (size: number) => {
      const t0 = performance.now()
      const r = await burstOn(pc, size)
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
      return (r.body.length * 8) / (performance.now() - t0) / 1000
    }
    const saver = dataSaverOn()
    const warm = saver ? undefined : await burst(MIB)
    const runs: number[] = []
    for (let i = 0; i < 3; i++)
      runs.push(
        await burst(
          warm === undefined ? MIB : burstSize(runs[runs.length - 1] ?? warm),
        ),
      )
    fresh = median(runs)
    error = undefined
    mine = { key, r: { mbps: fresh, at: Date.now() } }
    if (!saver)
      try {
        localStorage.setItem(key, JSON.stringify(mine.r))
      } catch {
        // not stored: the next tunnel measures again
      }
    event(
      `speed: ~${fresh.toFixed(1)} Mbps (median of ${runs.map((r) => r.toFixed(1)).join(' / ')}, ${warm !== undefined ? `warm-up ${warm.toFixed(1)} dropped` : 'data saver: 3 × 1 MiB, not kept'}; ${where(key)})`,
    )
  }

  const run = (force: boolean) => {
    if (running) return running // ponytail: a change mid-run keeps that run's key
    lastType = type()
    running = (async () => {
      const { key, r } = await current()
      const now = Date.now()
      const next = force ? 'measure' : plan(speedEvery(), r, now)
      if (next === 'measure') return bursts(key)
      if (r)
        event(
          `speed: ~${r.mbps.toFixed(1)} Mbps (cached, ${r.at ? age(now - r.at) : 'no time'}; ${where(key)})`,
        )
      else event('speed: not measured (Measure connection speed: Off)')
    })()
      .catch((e: Error) => {
        error = e.message
        event(`speed: failed (${e.message})`)
      })
      .finally(() => (running = undefined))
    return running
  }
  const change = () => {
    if (switched(lastType, type())) void run(false)
  }
  connection()?.addEventListener('change', change)
  const known = async () => (await current()).r?.mbps
  return {
    auto: async (wait) => {
      await Promise.race([run(false), new Promise((r) => setTimeout(r, wait))])
      return known()
    },
    known,
    test: async () => {
      await running
      await run(true)
    },
    fresh: () => fresh,
    error: () => error,
    stop: () => connection()?.removeEventListener('change', change),
  }
}

const where = (key: string) => key.split(':').slice(2).join(', ')
