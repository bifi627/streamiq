import { describe, type AppError } from '../../shared/errors.ts'
import type { Library } from '../../generated/jellyfin.ts'

// Each list read signs Jellyfin's admin in and out on the gateway: not faster.
export const LIBRARIES_POLL = 3_000
// Jellyfin queues a Rescan: the library reads idle until the scan starts.
export const RESCAN_GRACE = 10_000

// ms, false = stop: polled while a library scans (or a Rescan may still start), never after an error.
export const nextLibrariesAsk = (
  list: Library[] | undefined,
  failed: boolean,
  rescanAt: number,
  now: number,
): number | false =>
  !failed && (list?.some((l) => l.scanning) || now - rescanAt < RESCAN_GRACE)
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

export const extrasLabel = (extras: string) =>
  extras === 'custom' ? 'Extras: custom (set in Jellyfin)' : 'Extras'
