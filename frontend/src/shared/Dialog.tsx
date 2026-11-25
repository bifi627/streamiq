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
  // Read at the first render, before showModal moves focus into the dialog.
  const opener = useRef(document.activeElement)
  // No close() on unmount: its close event would call onClose (and dev's
  // StrictMode re-runs this effect). Chrome 87 throws on a second showModal.
  // Chromium 87 (webOS) leaves focus on <body> after close(), where no arrow
  // key moves it: give it back to the opener, as newer browsers do.
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal()
    const el = opener.current
    return () => {
      if (document.activeElement !== document.body) return
      if (el instanceof HTMLElement && el.isConnected) el.focus()
    }
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
