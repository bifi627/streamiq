// Arrow-key focus moves: a TV remote's D-pad sends arrow keys. Put
// onKeyDown={arrowFocus} on a container (nav, list, grid): an arrow moves focus
// to the nearest focusable element inside it in that direction. Enter is the
// browser's own on links and buttons (Enter in a form's field submits it).
// Selects, textareas, number fields and radios keep their arrows; other one-line
// fields and sliders: up/down leave them, left/right only past a text caret's end
// (a slider has no caret, so it keeps left/right: the remote's seek).
// Checkboxes use no arrows: every arrow leaves them.
import type { KeyboardEvent } from 'react'

type Box = { left: number; top: number; right: number; bottom: number }
const dirs = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']

/** Index of the box nearest to `from` in the arrow's direction, -1 = none.
 * Distance along the arrow counts once, sideways drift twice. Drift is from
 * the box's centre to `from`'s span: 0 under a wide row (a <summary>), so Down
 * reaches a control at its right end before the next row. */
export function nearest(from: Box, boxes: Box[], key: string) {
  const cx = (b: Box) => (b.left + b.right) / 2
  const cy = (b: Box) => (b.top + b.bottom) / 2
  const drift = (c: number, lo: number, hi: number) =>
    c < lo ? c - lo : c > hi ? c - hi : 0
  const across = key === 'ArrowLeft' || key === 'ArrowRight'
  let best = -1
  let score = Infinity
  boxes.forEach((b, i) => {
    const dx = across ? cx(b) - cx(from) : drift(cx(b), from.left, from.right)
    const dy = across ? drift(cy(b), from.top, from.bottom) : cy(b) - cy(from)
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
  'a[href], summary, button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Left/right leave a one-line field only from its caret's end on that side
// (no selection); fields without a caret API (email) keep them.
function caretAtEdge(el: HTMLInputElement, key: string) {
  if (key === 'ArrowUp' || key === 'ArrowDown') return true
  const { selectionStart: a, selectionEnd: b } = el
  if (a === null || a !== b) return false
  return key === 'ArrowLeft' ? a === 0 : a === el.value.length
}

export function arrowFocus(e: KeyboardEvent<HTMLElement>) {
  const from = e.target as HTMLElement
  if (
    !dirs.includes(e.key) ||
    e.altKey ||
    e.ctrlKey ||
    e.metaKey ||
    e.shiftKey || // browser shortcuts
    e.defaultPrevented || // an inner container moved already
    from.matches('select, textarea, input[type=number], input[type=radio]') ||
    (from instanceof HTMLInputElement &&
      from.type !== 'checkbox' &&
      !caretAtEdge(from, e.key))
  )
    return
  const els = [
    ...e.currentTarget.querySelectorAll<HTMLElement>(focusable),
  ].filter(
    (el) =>
      el !== from &&
      el.getClientRects().length > 0 &&
      // A closed <details>' content keeps its boxes in current Chrome
      // (content-visibility: hidden); Chrome 87 has neither those boxes nor
      // checkVisibility.
      (el.checkVisibility?.() ?? true),
  )
  const i = nearest(
    from.getBoundingClientRect(),
    els.map((el) => el.getBoundingClientRect()),
    e.key,
  )
  if (i < 0) return
  e.preventDefault() // no page scroll
  els[i].focus()
}
