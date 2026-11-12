// Gateway → client throughput (#162): 3 × 1 MiB bursts (/streamiq/burst, #90)
// over the tunnel in the background, median in Mbps. Runs when a session comes
// up and again on a navigator.connection `change` (where supported). The last
// value is kept in localStorage as the next session's starting hint, per
// gateway + direct/relay + connection type.
import { event } from './diag'
import { pairInfo } from './stats'
import { tunnelFetch } from './tunnel'
import { median } from './features/library/profile'

const BURST = 1 << 20

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
      const runs: number[] = []
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now()
        const r = await tunnelFetch(pc, `/streamiq/burst?size=${BURST}`)
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
        runs.push((r.body.length * 8) / (performance.now() - t0) / 1000)
      }
      fresh = median(runs)
      error = undefined
      try {
        localStorage.setItem(key, fresh.toFixed(1))
      } catch {
        // not kept: the next session starts without a hint
      }
      event(
        `speed: ~${fresh.toFixed(1)} Mbps (median of ${runs.map((r) => r.toFixed(1)).join(' / ')}; ${key.split(':').slice(2).join(', ')})`,
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
