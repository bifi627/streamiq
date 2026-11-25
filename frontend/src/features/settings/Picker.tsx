import { useState } from 'react'
import { Dialog } from '../../shared/Dialog'

export type Choice = { id: string; text: string }

// One of many, for the D-pad: a native <select> keeps the arrows (focus.ts)
// and Chromium changes it on a stray Up/Down. OK opens the choices in a modal;
// a pick applies and closes it.
export function Picker({
  label,
  choices,
  current,
  pick,
}: {
  label: string
  choices: Choice[]
  current: string | null
  pick: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const text = choices.find((c) => c.id === current)?.text ?? 'None'
  return (
    <div className="setting">
      {label}
      <button
        type="button"
        className="picker"
        aria-haspopup="dialog"
        aria-label={`${label}: ${text}`}
        onClick={() => setOpen(true)}
      >
        {text}
      </button>
      {open && (
        <Dialog title={label} onClose={() => setOpen(false)}>
          <ul className="picks">
            {choices.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  aria-pressed={c.id === current}
                  onClick={(e) => {
                    if (c.id !== current) pick(c.id)
                    e.currentTarget.closest('dialog')?.close()
                  }}
                >
                  {c.text}
                </button>
              </li>
            ))}
          </ul>
        </Dialog>
      )}
    </div>
  )
}
