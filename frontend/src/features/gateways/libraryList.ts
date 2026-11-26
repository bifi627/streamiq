import { describe, toAppError, type AppError } from '../../shared/errors.ts'
import type { Library, MediaFolder } from '../../generated/jellyfin.ts'

// Each list read signs Jellyfin's admin in and out on the gateway: not faster.
export const LIBRARIES_POLL = 3_000
// Jellyfin queues a Rescan: the library reads idle until the scan starts.
export const RESCAN_GRACE = 10_000

export const rescanPending = (rescanAt: number, now: number) =>
  now - rescanAt < RESCAN_GRACE

// ms, false = stop: polled while a library scans (or a Rescan may still start), never after an error.
export const nextLibrariesAsk = (
  list: Library[] | undefined,
  failed: boolean,
  rescanAt: number,
  now: number,
): number | false =>
  !failed && (list?.some((l) => l.scanning) || rescanPending(rescanAt, now))
    ? LIBRARIES_POLL
    : false

// 404: a gateway from before these endpoints; 409: a Jellyfin the gateway
// didn't set up; a 'http' 502 carries Jellyfin's own message, a 'http' 400
// why the gateway refused (api.ts).
export const librariesMessage = (e: AppError) =>
  e.context.status === 404
    ? 'Update the gateway to manage libraries here.'
    : e.context.status === 409
      ? "Libraries are managed in your Jellyfin's Dashboard."
      : e.kind === 'http' && e.context.status === 502
        ? `Jellyfin: ${e.message}`
        : e.kind === 'http' && e.context.status === 400
          ? e.message
          : describe(e).message

export type Rescan = { id: string; at: number }

// A Rescan's wait ends once its scan shows: a short one may finish inside the grace.
export const rescanSeen = (r: Rescan, list: Library[]): Rescan =>
  list.some((l) => l.id === r.id && l.scanning) ? { id: '', at: 0 } : r

export type LibraryAction = 'online' | 'extras' | 'rescan' | 'folders'

// Beside a library's name: its scan, or a Rescan sent (pressed, or queued in Jellyfin).
export const libraryStatus = (
  l: Library,
  action: LibraryAction | undefined,
  queued: boolean,
) =>
  l.scanning
    ? 'Scanning'
    : action === 'rescan' || queued
      ? 'Rescan queued…'
      : null

// The folders a library could add: the ones it doesn't hold yet.
export const addableFolders = (all: MediaFolder[], l: Library) =>
  all.filter((f) => !l.folders.includes(f.path))

// A folder in the picker: its path, and which libraries already use it.
export const folderLabel = (f: MediaFolder) =>
  f.libraries.length ? `${f.path} (in ${f.libraries.join(', ')})` : f.path

// An older gateway's list has no folders: no folder controls then.
export const hasFolders = (l: Library) => Array.isArray(l.folders)

// Jellyfin keeps a library's last folder (the library is removed instead);
// the gateway takes out only folders right under /media.
export const canRemoveFolder = (l: Library, folder: string) =>
  l.folders.length > 1 && /^\/media\/[^/]+$/.test(folder)

// The folder picker's note: the list's error, or that it's still loading.
export const foldersNote = (error: unknown, loaded: boolean) =>
  error ? librariesMessage(toAppError(error)) : loaded ? null : 'loading…'

export const removeLibraryQuestion = (l: Library) =>
  `Remove the library "${l.name}" from Jellyfin? Its files stay on disk.`

export type LibraryType = 'movies' | 'tvshows'

export type LibraryDraft = {
  name: string
  type: LibraryType
  folders: string[]
}

export const emptyDraft: LibraryDraft = {
  name: '',
  type: 'movies',
  folders: [],
}

// The gateway checks it too; this only keeps Create off until it can work.
export const draftReady = (d: LibraryDraft) =>
  d.name.trim() !== '' && d.folders.length > 0

export const toggleFolder = (d: LibraryDraft, path: string): LibraryDraft => ({
  ...d,
  folders: d.folders.includes(path)
    ? d.folders.filter((p) => p !== path)
    : [...d.folders, path],
})
