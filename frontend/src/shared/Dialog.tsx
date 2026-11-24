import { useEffect, useRef, type ReactNode } from 'react'
import { arrowFocus } from './focus'

// A modal on the native <dialog>: focus trap, Esc and the backdrop come with
// showModal. Centered on a desktop, a full-screen sheet on a phone (CSS).
// Mounted = open; Esc or Close call onClose, the caller unmounts it.
export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    d?.showModal()
    return () => d?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-label={title}
      onClose={onClose}
      // arrowFocus: the D-pad stays inside, as the page's container would.
      onKeyDown={arrowFocus}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button type="button" onClick={() => ref.current?.close()}>
          Close
        </button>
      </div>
      {children}
    </dialog>
  )
}
