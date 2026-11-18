// The phone remote's decisions (RemotePage in Library.tsx): plain data in,
// plain data out; RemotePage does the polling, the state and the render.

/** A seek target in seconds, kept in 0 … dur; no upper bound while the
 * duration is unknown (0). */
export const clampSeek = (t: number, dur: number) =>
  Math.max(0, dur ? Math.min(dur, t) : t)

/** What one poll of /streamiq/screens means: the screen to show (null: closed;
 * absent: keep the last one), the error line, and whether to poll again. */
export function polled<S extends { id: string }>(
  screenId: string,
  r: { screens: S[] } | { error: string },
): { screen?: S | null; down: string; again: boolean } {
  if ('error' in r) return { down: r.error, again: true }
  const screen = r.screens.find((x) => x.id === screenId) ?? null
  return { screen, down: '', again: screen !== null } // closed: ids never come back
}
