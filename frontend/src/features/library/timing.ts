// What the Engine (engine.ts) does with events that come early or late.

/** The first load's audio: a pick made while starting (a phone's) or
 * autoAudio's track, with the source's id: Jellyfin ignores
 * AudioStreamIndex without MediaSourceId. Neither = Jellyfin's default. */
export function startAudio(
  picked: number | undefined,
  auto: number | undefined,
  sourceId: string | undefined,
): { track?: number; source?: string } {
  const track = picked ?? auto
  return track === undefined ? {} : { track, source: sourceId }
}

/** `set` until close(): a closed engine's late failure (a load or play()
 * the teardown rejected) must not land on the next engine's player, which
 * shares the view. */
export function closable<T>(set: (p: T) => void) {
  let open = true
  return {
    set: (p: T) => {
      if (open) set(p)
    },
    close: () => {
      open = false
    },
  }
}
