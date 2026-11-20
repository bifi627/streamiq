// The phone remote's decisions (RemotePage in Screen.tsx): plain data in and out.
import type { Screen } from '../gateways/api'

/** Seconds, kept in 0 … dur; unbounded while dur is unknown (0). */
export const clampSeek = (t: number, dur: number) =>
  Math.max(0, dur ? Math.min(dur, t) : t)

/** One poll of /streamiq/screens: the screen to show (null: closed; absent:
 * keep the last), the error line, poll again?, and recovered (back after
 * wasDown's error: a command error from the outage is stale too). */
export function polled(
  screenId: string,
  r: { screens: Screen[] } | { error: string },
  wasDown = '',
): {
  screen?: Screen | null
  down: string
  again: boolean
  recovered: boolean
} {
  if ('error' in r) return { down: r.error, again: true, recovered: false }
  const screen = r.screens.find((x) => x.id === screenId) ?? null
  // closed: ids never come back
  return { screen, down: '', again: screen !== null, recovered: !!wasDown }
}
