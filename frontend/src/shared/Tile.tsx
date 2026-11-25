import type { ReactNode, Ref } from 'react'
import { Chevron } from './Chevron'

// An expandable tile in a .tiles grid, collapsed until opened (open: on load).
// onOpen: whether it is open, so a tile loads its data only then.
export function Tile({
  title,
  open,
  onOpen,
  summaryRef,
  children,
}: {
  title: string
  open?: boolean
  onOpen?: (open: boolean) => void
  summaryRef?: Ref<HTMLElement>
  children: ReactNode
}) {
  return (
    <details
      className="card tile"
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
