// The phone remote's decisions (RemotePage in Screen.tsx): plain data in and out.
import type { Screen } from '../gateways/api'

/** Seconds, kept in 0 … dur; unbounded while dur is unknown (0). */
export const clampSeek = (t: number, dur: number) =>
  Math.max(0, dur ? Math.min(dur, t) : t)

/** The last /streamiq/screens answer (undefined: none yet) and the current
 * poll error: the screen to show (null: closed; undefined: none yet), poll
 * again?, and recovered (back after wasDown's error: a command error from
 * the outage is stale too). An error keeps the last answer's screen. */
export function polled(
  screenId: string,
  screens: Screen[] | undefined,
  down: string,
  wasDown = '',
): { screen?: Screen | null; again: boolean; recovered: boolean } {
  // closed: ids never come back
  const screen = screens && (screens.find((x) => x.id === screenId) ?? null)
  return { screen, again: screen !== null, recovered: !!wasDown && !down }
}
