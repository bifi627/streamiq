import type { ReactNode, Ref } from 'react'
import { Chevron } from './Chevron'

// An expandable tile in a .tiles grid, collapsed until opened (open: on load).
// onOpen: whether it is open, so a tile loads its data only then. wide: both
// columns of the grid.
export function Tile({
  title,
  open,
  wide,
  onOpen,
  summaryRef,
  children,
}: {
  title: string
  open?: boolean
  wide?: boolean
  onOpen?: (open: boolean) => void
  summaryRef?: Ref<HTMLElement>
  children: ReactNode
}) {
  return (
    <details
      className={wide ? 'card tile wide' : 'card tile'}
      open={open}
      onToggle={(e) => onOpen?.(e.currentTarget.open)}
    >
      <summary ref={summaryRef}>
        {title}
        <Chevron />
      </summary>
      <div className="tile-body">{children}</div>
    </details>
  )
}
