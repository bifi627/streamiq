import { bytes } from '../activity/tunnels.ts'

// GET /streamiq/status `host` (docs/protocol.md): any field may be missing.
export type HostLoad = {
  cpu?: number
  memory?: { used: number; total: number }
  disk?: { free: number; total: number }
}

const pct = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 0,
})

const LOW_DISK = 5e9

// When to ask for the status again (ms; the gateway samples the CPU every
// 10 s), null = stop: a failed ask is not retried, each retry would open a
// new tunnel. Reopening Status asks again.
export const nextAsk = (ok: boolean): number | null => (ok ? 10_000 : null)

// The gateway card's "Load" line; null = no line (older gateway, or nothing measured).
export function loadLine(h: HostLoad | undefined): string | null {
  if (!h) return null
  const parts = [
    h.cpu !== undefined && `CPU ${pct.format(h.cpu / 100)}`,
    h.memory && `memory ${bytes(h.memory.used)} of ${bytes(h.memory.total)}`,
    h.disk && `disk ${bytes(h.disk.free)} free`,
  ].filter((p) => p)
  return parts.length ? `Load: ${parts.join(' · ')}` : null
}

export function loadHints(h: HostLoad | undefined): string[] {
  const hints = []
  // Rounded like the Load line: "CPU 90 %" always comes with the hint.
  if (h?.cpu !== undefined && Math.round(h.cpu) >= 90)
    hints.push(
      'The box is busy: playback may stutter. A GPU or a lower quality helps.',
    )
  if (h?.disk && h.disk.free < LOW_DISK)
    hints.push('Low disk space: transcodes may fail.')
  return hints
}
