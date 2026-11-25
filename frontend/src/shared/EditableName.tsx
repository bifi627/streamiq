import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { isBack } from '../features/library/items'

// The hint on inputs whose text leaves the user's hardware: our DB or Firebase.
// Not on what only the gateway keeps (client names): that's their box.
export const STORED = 'Saved by StreamIQ.'

// The name, plus an inline Rename (a paired client's, a household's): NameForm
// in its place while editing. arrowFocus reaches the controls. children
// replaces the shown name (the <h2> by default).
export function EditableName({
  name,
  label,
  rename,
  hint,
  children,
}: {
  name: string
  label: string
  rename?: (name: string) => Promise<string | null>
  hint?: string
  children?: ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const renameBtn = useRef<HTMLButtonElement>(null)
  const edited = useRef(false)
  // Closing the form unmounts the focused control: focus Rename again, or the
  // D-pad (arrowFocus on the section) loses its place, as in Pairing.
  useEffect(() => {
    if (!editing && edited.current) renameBtn.current?.focus()
    edited.current = editing
  }, [editing])
  // !rename: went offline mid-edit, so the name only.
  if (!editing || !rename)
    return (
      <div className="name">
        {children ?? <h2>{name}</h2>}
        {rename && (
          <button
            ref={renameBtn}
            type="button"
            className="link no-tv"
            onClick={() => setEditing(true)}
          >
            Rename
          </button>
        )}
      </div>
    )
  return (
    <NameForm
      name={name}
      label={label}
      hint={hint}
      rename={rename}
      onClose={() => setEditing(false)}
    />
  )
}

// The inline rename form: Enter saves (form submit), Escape / the remote's
// Back cancels; onClose after either. hint: a line under the input. icons: ✓ /
// ✕ for Save / Cancel, one line in a narrow spot (the title row).
export function NameForm({
  name,
  label,
  rename,
  hint,
  icons,
  onClose,
}: {
  name: string
  label: string
  rename: (name: string) => Promise<string | null>
  hint?: string
  icons?: boolean
  onClose: () => void
}) {
  const hintId = useId()
  const [draft, setDraft] = useState(name)
  const [error, setError] = useState<string | null>(null)
  return (
    <form
      className="name"
      onSubmit={async (e) => {
        e.preventDefault()
        const e2 = await rename(draft.trim())
        if (e2) setError(e2)
        else onClose()
      }}
      onKeyDown={(e) => {
        if (!isBack(e.nativeEvent)) return
        e.preventDefault() // else the browser's own Back runs too (webOS remote)
        onClose()
      }}
    >
      <input
        aria-label={label}
        aria-describedby={hint && hintId}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setError(null)
        }}
        maxLength={100}
        required
        pattern=".*\S.*"
        autoFocus
      />
      <button
        type="submit"
        className={icons ? 'primary icon-btn' : 'primary'}
        aria-label="Save"
        title="Save"
      >
        {icons ? <Icon d="M5 12l5 5 9-10" /> : 'Save'}
      </button>
      <button
        type="button"
        className={icons ? 'icon-btn' : undefined}
        aria-label="Cancel"
        title="Cancel"
        onClick={onClose}
      >
        {icons ? <Icon d="M6 6l12 12M18 6L6 18" /> : 'Cancel'}
      </button>
      {hint && (
        <p id={hintId} className="hint muted">
          {hint}
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

const Icon = ({ d }: { d: string }) => (
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path d={d} />
  </svg>
)
