// Library browsing over the tunnel (MVP item 5, consumption only). Functional,
// not pretty: the UI is refactored later. Routes (App.tsx): /g/$gatewayId owns the
// tunnel; its children (home, /i/$itemId) render through <Outlet /> and share it.
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import {
  Link,
  Outlet,
  useCanGoBack,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { PinMismatch, share, type Session } from '../pairing/connect'
import { tunnelFetch, tunnelJson } from '../../tunnel'
import { Player } from './Player'
import { clock, TICKS_PER_SECOND, type Item } from './items'
import { pairInfo, type PairInfo } from '../../stats'
import type { Speed } from '../../speed'

type Page = { Items: Item[] }
type View =
  | { kind: 'home' }
  | { kind: 'folder'; item: Item }
  | { kind: 'series'; item: Item }
  | { kind: 'season'; item: Item }

const playable = (i: Item) =>
  !i.IsFolder && i.Type !== 'Series' && i.Type !== 'Season'

const Tunnel = createContext<{
  gatewayId: string
  pc: RTCPeerConnection
  speed?: Speed
}>(null!)

// Layout route: the gateway's shared tunnel (#152), held while navigating inside
// it; leaving releases it (closed 30 s later unless reused).
export function GatewayLibrary({ gatewayId }: { gatewayId: string }) {
  const [session, setSession] = useState<Session | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const { session, release } = share(gatewayId)
    let gone = false
    session.then(
      (x) => {
        if (gone) return
        x.speed() // measure on first use, once per session (#162)
        setSession(x)
      },
      (e: Error) =>
        setErr(
          e instanceof PinMismatch
            ? `Refused: this is not the gateway you paired with. ${e.message}`
            : e.message,
        ),
    )
    return () => {
      gone = true
      release()
    }
  }, [gatewayId])

  return (
    <section>
      <p>
        <Link to="/">← Gateways</Link>
      </p>
      {err && <p style={{ color: 'crimson' }}>{err}</p>}
      {!session && !err && <p>Connecting…</p>}
      {session && (
        <Tunnel.Provider
          value={{ gatewayId, pc: session.pc, speed: session.speed() }}
        >
          <Privacy pc={session.pc} />
          <Outlet />
        </Tunnel.Provider>
      )}
    </section>
  )
}

export const LibraryHome = () => <Browse view={HOME} />
const HOME: View = { kind: 'home' }

// Folder / series / season by Jellyfin item ID, so a reload or deep link restores it.
export function ItemPage({ itemId }: { itemId: string }) {
  const { pc } = useContext(Tunnel)
  const [item, setItem] = useState<Item | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    tunnelJson<Item>(pc, `/Items/${itemId}`).then(setItem, (e: Error) =>
      setErr(e.message),
    )
  }, [pc, itemId])
  const view = useMemo<View | null>(
    () =>
      item && {
        kind:
          item.Type === 'Series'
            ? 'series'
            : item.Type === 'Season'
              ? 'season'
              : 'folder',
        item,
      },
    [item],
  )
  if (err) return <p style={{ color: 'crimson' }}>{err}</p>
  if (!view) return <p>Loading…</p>
  return <Browse view={view} />
}

// Player route: leaving it any way unmounts the Player, whose cleanup saves the
// position. Back goes back in history; after a deep link (no in-app history)
// it goes to the item's listing instead of leaving the app.
export function PlayerPage({ itemId }: { itemId: string }) {
  const { gatewayId, pc, speed } = useContext(Tunnel)
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const navigate = useNavigate()
  const back = (i: Item | null) => {
    if (canGoBack) return router.history.back()
    const parent = i?.SeasonId ?? i?.ParentId
    navigate(
      parent
        ? {
            to: '/g/$gatewayId/i/$itemId',
            params: { gatewayId, itemId: parent },
            replace: true,
          }
        : { to: '/g/$gatewayId', params: { gatewayId }, replace: true },
    )
  }
  return <Player pc={pc} speed={speed} itemId={itemId} onExit={back} />
}

// Breadcrumbs from the item itself + the listing.
function Browse({ view }: { view: View }) {
  const { gatewayId, pc } = useContext(Tunnel)
  const navigate = useNavigate()
  const item = view.kind === 'home' ? null : view.item
  const crumb = (itemId: string, name: string) => (
    <>
      {' / '}
      <Link to="/g/$gatewayId/i/$itemId" params={{ gatewayId, itemId }}>
        {name}
      </Link>
    </>
  )
  const open = (i: Item) =>
    navigate({
      to: playable(i)
        ? '/g/$gatewayId/play/$itemId'
        : '/g/$gatewayId/i/$itemId',
      params: { gatewayId, itemId: i.Id },
    })

  return (
    <>
      <p>
        <Link to="/g/$gatewayId" params={{ gatewayId }}>
          Library
        </Link>
        {item?.SeriesId &&
          item.SeriesId !== item.Id &&
          crumb(item.SeriesId, item.SeriesName ?? 'Series')}
        {item && crumb(item.Id, item.Name)}
      </p>
      <Listing pc={pc} view={view} onOpen={open} />
    </>
  )
}

function Listing({
  pc,
  view,
  onOpen,
}: {
  pc: RTCPeerConnection
  view: View
  onOpen: (i: Item) => void
}) {
  const [rows, setRows] = useState<[string, Item[]][] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const get = (url: string) => tunnelJson<Page>(pc, url).then((p) => p.Items)
    const load: Promise<[string, Item[]][]> =
      view.kind === 'home'
        ? Promise.all([
            get('/UserItems/Resume?mediaTypes=Video&limit=12'),
            get('/UserViews'),
          ]).then(([resume, views]) => [
            ['Continue watching', resume],
            ['Libraries', views],
          ])
        : view.kind === 'series'
          ? get(`/Shows/${view.item.Id}/Seasons`).then((s) => [['Seasons', s]])
          : view.kind === 'season'
            ? get(
                `/Shows/${view.item.SeriesId}/Episodes?seasonId=${view.item.Id}`,
              ).then((e) => [['Episodes', e]])
            : get(`/Items?parentId=${view.item.Id}&sortBy=SortName`).then(
                (i) => [['', i]],
              )
    load.then(setRows, (e: Error) => setErr(e.message))
  }, [pc, view])

  if (err) return <p style={{ color: 'crimson' }}>{err}</p>
  if (!rows) return <p>Loading…</p>
  return (
    <>
      {rows.map(
        ([title, items]) =>
          (items.length > 0 || title === '') && (
            <div key={title}>
              {title && <h3>{title}</h3>}
              {items.length === 0 && <p>Nothing here.</p>}
              <ul
                style={{
                  listStyle: 'none',
                  padding: 0,
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
                  gap: 12,
                }}
              >
                {items.map((i) => (
                  <li key={i.Id}>
                    <button
                      type="button"
                      onClick={() => onOpen(i)}
                      style={{ width: '100%', textAlign: 'left' }}
                    >
                      <Poster pc={pc} item={i} />
                      <div>
                        {i.IndexNumber != null &&
                          i.Type === 'Episode' &&
                          `${i.IndexNumber}. `}
                        {i.Name}
                        {i.ProductionYear && ` (${i.ProductionYear})`}
                      </div>
                      <small>{label(i)}</small>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ),
      )}
    </>
  )
}

// Privacy indicator: what StreamIQ can see of this stream, from the live selected
// candidate pair. Either way the tunnel is DTLS end to end (pinned both ways).
function Privacy({ pc }: { pc: RTCPeerConnection }) {
  const [p, setP] = useState<PairInfo | null>(null)
  useEffect(() => {
    const poll = () =>
      pc.getStats().then(
        (s) => setP(pairInfo(s)),
        () => {},
      )
    poll()
    const t = setInterval(poll, 2000)
    return () => clearInterval(t)
  }, [pc])
  if (!p) return null
  const mb = ((p.bytesReceived + p.bytesSent) / 1e6).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })
  return (
    <p>
      <small>
        🔒{' '}
        {p.relay
          ? `relayed (encrypted, StreamIQ cannot decrypt) · ${mb} MB relayed`
          : 'end-to-end encrypted · direct · StreamIQ carried 0 bytes'}
      </small>
    </p>
  )
}

function label(i: Item) {
  if (!playable(i)) return i.Type
  const pos = i.UserData?.PlaybackPositionTicks ?? 0
  if (i.UserData?.Played) return 'Watched'
  return pos > 0 ? `Resume ${clock(pos / TICKS_PER_SECOND)}` : 'Play'
}

// Posters come through the tunnel too, as blob URLs. ponytail: at most 4 image
// channels in flight; lazy-load with IntersectionObserver if big libraries hurt.
let active = 0
const waiting: (() => void)[] = []
async function limited<T>(fn: () => Promise<T>) {
  if (active >= 4) await new Promise<void>((r) => waiting.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    waiting.shift()?.()
  }
}

function Poster({ pc, item }: { pc: RTCPeerConnection; item: Item }) {
  const [src, setSrc] = useState<string | null>(null)
  const tag = item.ImageTags?.Primary
  useEffect(() => {
    if (!tag) return
    let url: string | null = null
    let gone = false
    limited(() =>
      tunnelFetch(
        pc,
        `/Items/${item.Id}/Images/Primary?maxWidth=280&tag=${tag}`,
      ),
    ).then(
      (r) => {
        if (gone || r.status !== 200) return
        url = URL.createObjectURL(
          new Blob([r.body], { type: r.headers['Content-Type'] }),
        )
        setSrc(url)
      },
      () => {},
    )
    return () => {
      gone = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [pc, item.Id, tag])
  return (
    <div style={{ aspectRatio: '2 / 3', background: '#ddd' }}>
      {src && (
        <img
          src={src}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      )}
    </div>
  )
}
