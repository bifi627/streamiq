// Arrow-key focus moves (#201): a TV remote's D-pad sends arrow keys. Put
// onKeyDown={arrowFocus} on a container (nav, list, grid): an arrow moves focus
// to the nearest focusable element inside it in that direction. Enter is the
// browser's own on links and buttons. Text fields and selects keep their arrows.
import type { KeyboardEvent } from 'react'

type Box = { left: number; top: number; right: number; bottom: number }
const dirs = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']

/** Index of the box nearest to `from` in the arrow's direction, -1 = none.
 * Distance along the arrow counts once, sideways drift twice. */
export function nearest(from: Box, boxes: Box[], key: string) {
  const cx = (b: Box) => (b.left + b.right) / 2
  const cy = (b: Box) => (b.top + b.bottom) / 2
  const across = key === 'ArrowLeft' || key === 'ArrowRight'
  let best = -1
  let score = Infinity
  boxes.forEach((b, i) => {
    const dx = cx(b) - cx(from)
    const dy = cy(b) - cy(from)
    const along = {
      ArrowLeft: -dx,
      ArrowRight: dx,
      ArrowUp: -dy,
      ArrowDown: dy,
    }[key]
    if (along === undefined || along <= 0) return
    const s = along + 2 * Math.abs(across ? dy : dx)
    if (s < score) [best, score] = [i, s]
  })
  return best
}

const focusable =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function arrowFocus(e: KeyboardEvent<HTMLElement>) {
  const from = e.target as HTMLElement
  if (
    !dirs.includes(e.key) ||
    e.altKey ||
    e.ctrlKey ||
    e.metaKey ||
    e.shiftKey || // browser shortcuts
    e.defaultPrevented || // an inner container moved already
    from.matches('input, select, textarea')
  )
    return
  const els = [
    ...e.currentTarget.querySelectorAll<HTMLElement>(focusable),
  ].filter((el) => el !== from && el.getClientRects().length > 0)
  const i = nearest(
    from.getBoundingClientRect(),
    els.map((el) => el.getBoundingClientRect()),
    e.key,
  )
  if (i < 0) return
  e.preventDefault() // no page scroll
  els[i].focus()
}
