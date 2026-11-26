import { useState } from 'react'
import {
  addLibraryFolder,
  createLibrary,
  removeLibrary,
  removeLibraryFolder,
  type Gateway,
  type Library,
  type MediaFolder,
} from './api'
import {
  addableFolders,
  canRemoveFolder,
  foldersNote,
  draftReady,
  emptyDraft,
  folderLabel,
  removeLibraryQuestion,
  toggleFolder,
  type LibraryAction,
  type LibraryType,
} from './libraryList'

type Act = (
  id: string,
  what: LibraryAction,
  run: () => Promise<unknown>,
) => Promise<void>

// Folders come only from what the managed Jellyfin sees under /media: mounting
// one happens on the gateway's host, never from here.
function MissingFolder() {
  return (
    <p className="hint muted">
      A folder isn&apos;t there? Mount it on the gateway&apos;s host: add it to{' '}
      <code>jellyfin-compose.yml</code> (docs/install.md, &quot;Add your media
      libraries&quot;).
    </p>
  )
}

// Add library: a name, Movies or Shows, one or more folders. Always created
// with online lookups and the extras off.
export function AddLibrary(p: {
  g: Gateway
  ready: boolean // the list has loaded
  folders: MediaFolder[] | undefined
  foldersError: unknown
  act: Act
}) {
  const [open, setOpen] = useState(false)
  const note = foldersNote(p.foldersError, !!p.folders)
  const [d, setD] = useState(emptyDraft)
  const [busy, setBusy] = useState(false)
  if (!p.ready) return null
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Add library
      </button>
    )
  return (
    <form
      className="add-library"
      onSubmit={(e) => {
        e.preventDefault()
        setBusy(true)
        void p
          .act('', 'folders', async () => {
            await createLibrary(p.g.id, { ...d, name: d.name.trim() })
            setD(emptyDraft)
            setOpen(false)
          })
          .finally(() => setBusy(false))
      }}
    >
      <label>
        Name{' '}
        <input
          value={d.name}
          onChange={(e) => setD({ ...d, name: e.currentTarget.value })}
        />
      </label>
      <label>
        Holds{' '}
        <select
          value={d.type}
          onChange={(e) =>
            setD({ ...d, type: e.currentTarget.value as LibraryType })
          }
        >
          <option value="movies">Movies</option>
          <option value="tvshows">Shows</option>
        </select>
      </label>
      <fieldset>
        <legend>Folders</legend>
        {note && <p role="status">{note}</p>}
        {p.folders?.length === 0 && <p>No folders under /media yet.</p>}
        {p.folders?.map((f) => (
          <label key={f.path}>
            <input
              type="checkbox"
              checked={d.folders.includes(f.path)}
              onChange={() => setD(toggleFolder(d, f.path))}
            />{' '}
            {folderLabel(f)}
          </label>
        ))}
        <MissingFolder />
      </fieldset>
      <p className="hint muted">
        New libraries start with online lookups and the extras off.
      </p>
      <div className="actions">
        <button type="submit" disabled={busy || !draftReady(d)}>
          {busy ? 'Creating…' : 'Create'}
        </button>
        <button
          type="button"
          className="link"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

// A library's folders: Remove folder (never its last), Add folder, Remove library.
export function LibraryFolders(p: {
  g: Gateway
  l: Library
  folders: MediaFolder[] | undefined
  busy: boolean
  act: Act
}) {
  const { g, l, act } = p
  const addable = addableFolders(p.folders ?? [], l)
  const [pick, setPick] = useState('')
  const chosen = addable.some((f) => f.path === pick) ? pick : ''
  return (
    <>
      <ul className="lib-folders">
        {l.folders.map((f) => (
          <li key={f}>
            <code>{f}</code>
            {canRemoveFolder(l, f) && (
              <button
                type="button"
                className="link"
                disabled={p.busy}
                onClick={() =>
                  act(l.id, 'folders', () => removeLibraryFolder(g.id, l.id, f))
                }
              >
                Remove folder
              </button>
            )}
          </li>
        ))}
      </ul>
      {!!addable.length && (
        <div className="lib-add-folder">
          <select
            aria-label={`Folder to add to ${l.name}`}
            value={chosen}
            disabled={p.busy}
            onChange={(e) => setPick(e.currentTarget.value)}
          >
            <option value="">Pick a folder…</option>
            {addable.map((f) => (
              <option key={f.path} value={f.path}>
                {folderLabel(f)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={p.busy || !chosen}
            onClick={() =>
              act(l.id, 'folders', () => addLibraryFolder(g.id, l.id, chosen))
            }
          >
            Add folder
          </button>
        </div>
      )}
      <button
        type="button"
        className="link"
        disabled={p.busy}
        onClick={() => {
          if (confirm(removeLibraryQuestion(l)))
            void act(l.id, 'folders', () => removeLibrary(g.id, l.id))
        }}
      >
        Remove library
      </button>
    </>
  )
}
