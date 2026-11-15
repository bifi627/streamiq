// Gateway → client throughput (#162): a 1 MiB warm-up burst (/streamiq/burst,
// #90; dropped: its read is mostly ramp-up, #259), then 3 bursts sized to last
// ~2 s each at the last read, in the background; median in Mbps. Runs when a session first
// asks for it (#152) and again on a navigator.connection `change` (where supported). The last
// value is kept in localStorage as the next session's starting hint, per
// gateway + direct/relay + connection type. Data saver (#291): no warm-up and
// 3 × 1 MiB (~3 MB), not kept as the hint (it reads low: ramp-up).
import { event } from './diag'
import { pairInfo } from './stats'
import { tunnelFetch } from './tunnel'
import { burstSize, median } from './features/library/profile'
import { dataSaverOn } from './settings'

const MIB = 1 << 20

type Connection = EventTarget & { type?: string }
const connection = () =>
  (navigator as Navigator & { connection?: Connection }).connection

export type Speed = {
  /** Mbps: the fresh measurement, else the hint; waits at most `wait` ms for
   * a running one. undefined = nothing known. */
  get: (wait?: number) => Promise<number | undefined>
  /** This session's last measurement (telemetry, diagnostics). */
  fresh: () => number | undefined
  error: () => string | undefined
  stop: () => void
}

export function measure(pc: RTCPeerConnection, gatewayId: string): Speed {
  let fresh: number | undefined
  let hint: number | undefined
  let error: string | undefined
  let running: Promise<void> | undefined
  const run = () => {
    if (running) return // ponytail: a change mid-run keeps that run's key
    running = (async () => {
      const p = pairInfo(await pc.getStats())
      const key = `streamiq.speed:${gatewayId}:${p?.relay ? 'relay' : 'direct'}:${connection()?.type ?? '?'}`
      try {
        hint = Number(localStorage.getItem(key)) || undefined
      } catch {
        // no storage: no hint
      }
      const burst = async (size: number) => {
        const t0 = performance.now()
        const r = await tunnelFetch(pc, `/streamiq/burst?size=${size}`)
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
        return (r.body.length * 8) / (performance.now() - t0) / 1000
      }
      const saver = dataSaverOn()
      const warm = saver ? undefined : await burst(MIB)
      const runs: number[] = []
      for (let i = 0; i < 3; i++)
        runs.push(await burst(saver ? MIB : burstSize(runs.at(-1) ?? warm!)))
      fresh = median(runs)
      error = undefined
      if (!saver)
        try {
          localStorage.setItem(key, fresh.toFixed(1))
        } catch {
          // not kept: the next session starts without a hint
        }
      event(
        `speed: ~${fresh.toFixed(1)} Mbps (median of ${runs.map((r) => r.toFixed(1)).join(' / ')}, ${warm !== undefined ? `warm-up ${warm.toFixed(1)} dropped` : 'data saver: 3 × 1 MiB, not kept'}; ${key.split(':').slice(2).join(', ')})`,
      )
    })()
      .catch((e: Error) => {
        error = e.message
        event(`speed: failed (${e.message})`)
      })
      .finally(() => (running = undefined))
  }
  run()
  connection()?.addEventListener('change', run)
  return {
    get: async (wait = 3000) => {
      if (running)
        await Promise.race([running, new Promise((r) => setTimeout(r, wait))])
      return fresh ?? hint
    },
    fresh: () => fresh,
    error: () => error,
    stop: () => connection()?.removeEventListener('change', run),
  }
}
