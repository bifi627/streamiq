import type { ReactNode, Ref } from 'react'
import { Chevron } from '../../shared/Chevron'

// One of the gateway page's expandable tiles, collapsed until opened. onOpen:
// whether it is open, so a tile asks its gateway only then.
export function Tile({
  title,
  onOpen,
  summaryRef,
  children,
}: {
  title: string
  onOpen: (open: boolean) => void
  summaryRef?: Ref<HTMLElement>
  children: ReactNode
}) {
  return (
    <details
      className="card tile"
      onToggle={(e) => onOpen(e.currentTarget.open)}
    >
      <summary ref={summaryRef}>
        {title}
        <Chevron />
      </summary>
      <div className="tile-body">{children}</div>
    </details>
  )
}
