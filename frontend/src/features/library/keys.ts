// The control bar's key model (Controls.tsx header): which action a key takes,
// from where focus is. Plain data in, plain data out; Controls does the DOM.

export const SKIP = 10 // seconds per ←/→ seek

/** Where the key landed, read from the DOM by Controls. */
export type KeyAt = {
  back: boolean // Escape, GoBack, webOS 461 (isBack)
  key: string // e.key, lower case
  page: 'main' | 'options' | null // the popover's page; null: closed
  inPopover: boolean
  inBar: boolean
  shown: boolean // the bar is up
  seek: boolean // focus on the seek bar
  volume: boolean // focus on the volume slider
  lastRow: boolean // focus in the bar's last row
  dock: boolean // the diagnostics dock is there to go down to (#230)
  ctrl: boolean // modifiers held (e.ctrlKey, e.metaKey, e.altKey)
  meta: boolean
  alt: boolean
  repeat: boolean // the key is held down (e.repeat)
}

export type Action =
  | { do: 'close' } // the popover
  | { do: 'up' } // the popover's main page
  | { do: 'hide' } // the bar
  | { do: 'exit' } // the player
  | { do: 'fullscreen' }
  | { do: 'mute' }
  | { do: 'toggle' } // play-pause
  | { do: 'seek'; by: number }
  | { do: 'focusPlay' }
  | { do: 'stay' } // swallow the key, do nothing
  | { do: 'option'; by: -1 | 1 } // within the popover
  | { do: 'item'; by: -1 | 1 } // within a bar row
  | { do: 'row'; by: -1 | 1 }
  | { do: 'volume'; by: number }
  | { do: 'dock' }

// Keys that work anywhere in the player, the popover included.
const ANYWHERE = new Map<string, Action>([
  ['f', { do: 'fullscreen' }],
  ['m', { do: 'mute' }],
  ['k', { do: 'toggle' }],
])

/** The action for a key, or null: not ours, the browser's default applies. */
export function keyAction(x: KeyAt): Action | null {
  if (x.back)
    return x.page === 'main'
      ? { do: 'close' }
      : x.page === 'options'
        ? { do: 'up' }
        : x.inBar || x.shown
          ? { do: 'hide' }
          : { do: 'exit' }
  // The browser's shortcuts (Ctrl+F find, Alt+← back, …) stay the browser's (#549).
  if (x.ctrl || x.meta || x.alt) return null
  // Held down, a toggle fires once (the repeats are swallowed); arrows repeat.
  const once = (a: Action): Action => (x.repeat ? { do: 'stay' } : a)
  const anywhere = ANYWHERE.get(x.key)
  if (anywhere) return once(anywhere)
  const by = x.key === 'arrowleft' || x.key === 'arrowup' ? -1 : 1
  const horizontal = x.key === 'arrowleft' || x.key === 'arrowright'
  const vertical = x.key === 'arrowup' || x.key === 'arrowdown'
  if (x.inPopover)
    return vertical ? { do: 'option', by } : horizontal ? { do: 'stay' } : null
  if (!x.inBar) {
    if (horizontal) return { do: 'seek', by: by * SKIP }
    if (x.key === 'enter' || x.key === ' ') return once({ do: 'toggle' })
    return vertical ? { do: 'focusPlay' } : null
  }
  // Roving focus inside the bar; Enter/Space activate the focused control.
  if (horizontal)
    return x.seek ? { do: 'seek', by: by * SKIP } : { do: 'item', by }
  if (!vertical) return null
  if (x.volume) return { do: 'volume', by: -by * 0.1 }
  if (x.dock && by === 1 && x.lastRow) return { do: 'dock' }
  return { do: 'row', by }
}

/** Index i clamped into a list of n. */
export const clamp = (i: number, n: number) => Math.max(0, Math.min(n - 1, i))
