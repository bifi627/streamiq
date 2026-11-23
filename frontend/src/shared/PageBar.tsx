import { useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { SlotsContext } from './slots'

// The shell's title row: back (left), title (center), actions (right). A page
// renders this anywhere; the parts land in the shell's row through portals, so
// they keep the page's state, handlers and D-pad container (React events
// bubble through the page).
export function PageBar({
  title,
  onBack,
  actions,
}: {
  title?: ReactNode
  onBack?: () => void
  actions?: ReactNode
}) {
  const s = useContext(SlotsContext)
  if (!s) return null
  return (
    <>
      {onBack &&
        s.back &&
        createPortal(<BackButton onClick={onBack} />, s.back)}
      {title != null &&
        s.title &&
        createPortal(
          typeof title === 'string' ? <h1>{title}</h1> : title,
          s.title,
        )}
      {actions && s.actions && createPortal(actions, s.actions)}
    </>
  )
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="back"
      aria-label="Back"
      title="Back"
      onClick={onClick}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M15 6l-6 6 6 6" />
      </svg>
    </button>
  )
}
