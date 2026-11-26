import { describe, type AppError } from '../../shared/errors.ts'
import type { Library } from '../../generated/jellyfin.ts'

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
// didn't set up; a 'http' 502 carries Jellyfin's own message (api.ts).
export const librariesMessage = (e: AppError) =>
  e.context.status === 404
    ? 'Update the gateway to manage libraries here.'
    : e.context.status === 409
      ? "Libraries are managed in your Jellyfin's Dashboard."
      : e.kind === 'http' && e.context.status === 502
        ? `Jellyfin: ${e.message}`
        : describe(e).message

export type Rescan = { id: string; at: number }

// A Rescan's wait ends once its scan shows: a short one may finish inside the grace.
export const rescanSeen = (r: Rescan, list: Library[]): Rescan =>
  list.some((l) => l.id === r.id && l.scanning) ? { id: '', at: 0 } : r

export type LibraryAction = 'online' | 'extras' | 'rescan'

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
