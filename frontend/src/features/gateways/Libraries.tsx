import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  listLibraries,
  makeLibraryOffline,
  rescanLibrary,
  setLibraryExtras,
  type Gateway,
} from './api'
import { toAppError } from '../../shared/errors'
import { Tile } from '../../shared/Tile'
import {
  extrasLabel,
  librariesMessage,
  nextLibrariesAsk,
  rescanPending,
} from './libraryList'

// A managed Jellyfin's libraries (admin, paired browser), read live from
// Jellyfin over the shared tunnel once the tile opens; polled only while a
// library scans.
export function Libraries({ g }: { g: Gateway }) {
  const [open, setOpen] = useState(false)
  const [rescanAt, setRescanAt] = useState(0)
  const [msg, setMsg] = useState<string | null>(null) // an action's error
  const [busy, setBusy] = useState(false)
  const q = useQuery({
    queryKey: ['libraries', g.id],
    queryFn: () => listLibraries(g.id),
    enabled: open,
    refetchInterval: (x) =>
      nextLibrariesAsk(
        x.state.data,
        x.state.status === 'error',
        rescanAt,
        Date.now(),
      ),
    gcTime: 0,
    refetchOnWindowFocus: false, // a retry would open a tunnel
    refetchOnReconnect: false,
    retry: false,
  })

  async function act(run: () => Promise<unknown>, rescan = false) {
    setBusy(true)
    setMsg(null)
    try {
      await run()
      if (rescan) setRescanAt(Date.now())
    } catch (x) {
      setMsg(librariesMessage(toAppError(x)))
    }
    await q.refetch()
    setBusy(false)
  }

  const note = q.error
    ? librariesMessage(toAppError(q.error))
    : q.data
      ? null
      : 'loading…'
  return (
    <Tile title="Libraries" onOpen={setOpen}>
      {note && <p role="status">{note}</p>}
      {msg && <p role="status">{msg}</p>}
      {q.data?.length === 0 && (
        <p>No libraries yet. Add one in Jellyfin: Dashboard → Libraries.</p>
      )}
      {!!q.data?.length && (
        <>
          <p>
            <b>Offline</b>: Jellyfin looks nothing up online for the library.{' '}
            <b>Extras</b>: seek thumbnails, chapter images and audio
            normalization; StreamIQ doesn&apos;t show them, and they cost CPU
            and disk.
          </p>
          <ul className="libraries">
            {q.data.map((l) => (
              <li key={l.id}>
                <b>{l.name}</b>
                {l.scanning && (
                  <label>
                    Scanning{' '}
                    <progress max={100} value={l.progress}>
                      {l.progress}%
                    </progress>
                  </label>
                )}
                <span>
                  {l.offline ? 'Offline' : 'Online (set in Jellyfin)'}{' '}
                  {!l.offline && (
                    <button
                      type="button"
                      className="link"
                      disabled={busy}
                      onClick={() => act(() => makeLibraryOffline(g.id, l.id))}
                    >
                      Make offline
                    </button>
                  )}
                </span>
                <label>
                  <input
                    type="checkbox"
                    checked={l.extras === 'on'}
                    disabled={busy}
                    onChange={(e) => {
                      const on = e.currentTarget.checked
                      void act(() => setLibraryExtras(g.id, l.id, on))
                    }}
                  />{' '}
                  {extrasLabel(l.extras)}
                </label>
                <button
                  type="button"
                  disabled={
                    busy || l.scanning || rescanPending(rescanAt, Date.now())
                  }
                  onClick={() => act(() => rescanLibrary(g.id, l.id), true)}
                >
                  Rescan
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Tile>
  )
}
