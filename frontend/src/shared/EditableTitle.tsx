import { NameForm } from './EditableName'

// A PageBar title that becomes the one-line rename form (icon Save / Cancel)
// while editing; the page opens it (its ⋮ menu's Rename) and onClose ends it.
export function EditableTitle({
  title,
  editing,
  ...form
}: {
  title: string
  editing: boolean
  name: string
  label: string
  hint?: string
  rename: (name: string) => Promise<string | null>
  onClose: () => void
}) {
  return editing ? <NameForm {...form} icons /> : <h1>{title}</h1>
}
