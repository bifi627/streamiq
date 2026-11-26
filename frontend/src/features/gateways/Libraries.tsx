import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  listLibraries,
  rescanLibrary,
  setLibraryExtras,
  setLibraryOnline,
  type Gateway,
} from './api'
import { toAppError } from '../../shared/errors'
import { Tile } from '../../shared/Tile'
import {
  librariesMessage,
  libraryStatus,
  nextLibrariesAsk,
  rescanPending,
  rescanSeen,
  type LibraryAction,
} from './libraryList'

// A managed Jellyfin's libraries (admin, paired browser), read live from
// Jellyfin over the shared tunnel once the tile opens; polled only while a
// library scans.
export function Libraries({ g }: { g: Gateway }) {
  const [open, setOpen] = useState(false)
  const [rescan, setRescan] = useState({ id: '', at: 0 })
  const [msg, setMsg] = useState<string | null>(null) // an action's error
  const [pending, setPending] = useState<Record<string, LibraryAction>>({})
  const q = useQuery({
    queryKey: ['libraries', g.id],
    queryFn: async () => {
      const list = await listLibraries(g.id)
      setRescan((r) => rescanSeen(r, list))
      return list
    },
    enabled: open,
    refetchInterval: (x) =>
      nextLibrariesAsk(
        x.state.data,
        x.state.status === 'error',
        rescan.at,
        Date.now(),
      ),
    gcTime: 0,
    refetchOnWindowFocus: false, // a retry would open a tunnel
    refetchOnReconnect: false,
    retry: false,
  })

  async function act(
    id: string,
    what: LibraryAction,
    run: () => Promise<unknown>,
  ) {
    setPending((p) => ({ ...p, [id]: what }))
    setMsg(null)
    try {
      await run()
      if (what === 'rescan') setRescan({ id, at: Date.now() })
    } catch (x) {
      setMsg(librariesMessage(toAppError(x)))
    }
    await q.refetch()
    setPending((p) => {
      const next = { ...p }
      delete next[id]
      return next
    })
  }

  const note = q.error
    ? librariesMessage(toAppError(q.error))
    : q.data
      ? null
      : 'loading…'
  return (
    <Tile title="Libraries" onOpen={setOpen}>
      {note && <p role="status">{note}</p>}
      {msg && <p role="alert">{msg}</p>}
      {q.data?.length === 0 && (
        <p>No libraries yet. Add one in Jellyfin: Dashboard → Libraries.</p>
      )}
      {!!q.data?.length && (
        <>
          <p className="hint muted">
            Online lookups fetch titles, posters and descriptions from the
            internet; off, Jellyfin uses only what&apos;s in your folders. Seek
            previews, chapter images and the loudness scan cost CPU and disk,
            and StreamIQ doesn&apos;t show them.
          </p>
          <ul className="libraries">
            {q.data.map((l) => {
              const action = pending[l.id]
              // the last read's time, not Date.now(): render stays pure, and polls continue through the grace
              const queued =
                rescan.id === l.id && rescanPending(rescan.at, q.dataUpdatedAt)
              const status = libraryStatus(l, action, queued)
              return (
                <li key={l.id} aria-busy={!!action}>
                  <div className="lib-head">
                    <b>{l.name}</b>
                    {status ? (
                      <span className="muted">{status}</span>
                    ) : (
                      <button
                        type="button"
                        className="link"
                        disabled={!!action}
                        onClick={() =>
                          act(l.id, 'rescan', () => rescanLibrary(g.id, l.id))
                        }
                      >
                        Rescan
                      </button>
                    )}
                  </div>
                  {l.scanning && (
                    <progress
                      max={100}
                      value={l.progress}
                      aria-label={`${l.name}: scan progress`}
                    />
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={!l.offline}
                      disabled={!!action}
                      onChange={(e) => {
                        const on = e.currentTarget.checked
                        void act(l.id, 'online', () =>
                          setLibraryOnline(g.id, l.id, on),
                        )
                      }}
                    />{' '}
                    Online lookups
                    {action === 'online' && (
                      <span className="muted"> · saving…</span>
                    )}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={l.extras === 'on'}
                      disabled={!!action}
                      onChange={(e) => {
                        const on = e.currentTarget.checked
                        void act(l.id, 'extras', () =>
                          setLibraryExtras(g.id, l.id, on),
                        )
                      }}
                    />{' '}
                    Seek previews, chapter images, loudness scan
                    {action === 'extras' ? (
                      <span className="muted"> · saving…</span>
                    ) : (
                      l.extras === 'custom' && (
                        <span className="muted"> · a mix, set in Jellyfin</span>
                      )
                    )}
                  </label>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </Tile>
  )
}
