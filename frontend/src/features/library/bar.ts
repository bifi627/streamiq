// The control bar's decisions; Controls.tsx only reads the DOM and runs them.

/** Volume + mute per device from storage: 50 % when unset; a stored 0
 *  (slider dragged down = muted) comes back as muted at 50 %, so unmuting is audible. */
export function storedVolume(vol: string | null, muted: string | null) {
  const x = Number(vol ?? NaN)
  return { volume: x > 0 && x <= 1 ? x : 0.5, muted: muted === '1' }
}

export const seekTarget = (now: number, by: number, duration: number) =>
  Math.max(0, Math.min(duration, now + by))

/** A pointer down on the player: touch on the picture toggles the bar (a hidden
 *  bar ignores touches, see Player.css); a mouse or a touch on the bar shows it. */
export const tap = (mouse: boolean, onPicture: boolean, visible: boolean) =>
  !mouse && onPicture && visible ? 'hide' : 'poke'

/** A setting's row on the main page: current option + what is in effect. */
export const summary = (s: {
  value: string
  options: { value: string; label: string }[]
  status?: string
}) =>
  `${s.options.find((o) => o.value === s.value)?.label ?? ''}${s.status ? ` · ${s.status}` : ''} ›`
