import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { isBack } from '../library/items'

// The hint on inputs whose text leaves the user's hardware: our DB or Firebase.
// Not on what only the gateway keeps (client names): that's their box.
export const STORED = 'Saved by StreamIQ.'

// The name, plus an inline Rename: a gateway's for an admin while it is online
// and this browser is paired with it, a paired client's.
// Enter saves (form submit), Escape / the remote's Back cancels; arrowFocus
// reaches the controls. children replaces the shown name (the <h2> by default).
// hint: a line under the input while editing.
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
  const hintId = useId()
  const [draft, setDraft] = useState<string | null>(null) // null = not editing
  const [error, setError] = useState<string | null>(null)
  const renameBtn = useRef<HTMLButtonElement>(null)
  const edited = useRef(false)
  // Closing the form unmounts the focused control: focus Rename again, or the
  // D-pad (arrowFocus on the section) loses its place, as in Pairing.
  useEffect(() => {
    if (draft === null && edited.current) renameBtn.current?.focus()
    edited.current = draft !== null
  }, [draft])
  // !rename: went offline mid-edit, so the name only.
  if (draft === null || !rename)
    return (
      <div className="name">
        {children ?? <h2>{name}</h2>}
        {rename && (
          <button
            ref={renameBtn}
            type="button"
            className="link"
            onClick={() => {
              setDraft(name)
              setError(null)
            }}
          >
            Rename
          </button>
        )}
      </div>
    )
  return (
    <form
      className="name"
      onSubmit={async (e) => {
        e.preventDefault()
        const e2 = await rename(draft.trim())
        if (e2) setError(e2)
        else setDraft(null)
      }}
      onKeyDown={(e) => {
        if (!isBack(e.nativeEvent)) return
        e.preventDefault() // else the browser's own Back runs too (webOS remote)
        setDraft(null)
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
      <button type="submit" className="primary">
        Save
      </button>
      <button type="button" onClick={() => setDraft(null)}>
        Cancel
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
