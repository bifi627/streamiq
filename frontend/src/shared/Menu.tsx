import { useEffect, useRef, useState, type RefObject } from 'react'

export type Action = { label: string; run: () => void }

// The title row's ⋮: the page's actions in a small menu. Closes on a choice,
// Escape (focus back on ⋮) or a press outside it.
export function Menu({
  label,
  actions,
  button,
}: {
  label: string
  actions: Action[]
  button: RefObject<HTMLButtonElement | null>
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  return (
    <span
      className="menu no-tv"
      ref={root}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return
        e.stopPropagation()
        setOpen(false)
        button.current?.focus()
      }}
    >
      <button
        ref={button}
        type="button"
        className="icon-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M12 5h.01M12 12h.01M12 19h.01" />
        </svg>
      </button>
      {open && (
        <span className="menu-list" role="menu">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                // The item unmounts: keep the D-pad's place (a cancelled confirm).
                button.current?.focus()
                a.run()
              }}
            >
              {a.label}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}
