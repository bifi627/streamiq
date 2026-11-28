// The phone's decisions on screens (Play on… and RemotePage in Screen.tsx): plain data in and out.
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

/** Play on…'s choices: each open screen plays the item; one already playing
 * also offers its remote. */
export const playOnOptions = (screens: Screen[]) => [
  ...screens.map((s) => ({
    value: `play:${s.id}`,
    label: s.name,
    screenId: s.id,
    remote: false,
  })),
  ...playingScreens(screens).map((s) => ({
    value: `remote:${s.id}`,
    label: `Remote: ${s.name}`,
    screenId: s.id,
    remote: true,
  })),
]

/** The screens playing something. */
export const playingScreens = (screens: Screen[]) =>
  screens.filter((s) => s.state?.itemId)

// The gateway's pages without the Now playing bar: full-screen ones and the
// screen feature's own.
const NO_BAR = new Set([
  '/g/$gatewayId/play/$itemId',
  '/g/$gatewayId/remote/$screenId',
  '/g/$gatewayId/screen',
])

/** Whether the page with this leaf route id shows the Now playing bar. */
export const nowPlayingOn = (routeId: string | undefined, tv: boolean) =>
  !tv && !!routeId && !NO_BAR.has(routeId)
