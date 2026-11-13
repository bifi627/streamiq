// Library browsing over the tunnel (MVP item 5, consumption only). Functional,
// not pretty: the UI is refactored later. Routes (App.tsx): /g/$gatewayId owns the
// tunnel; its children (home, /i/$itemId) render through <Outlet /> and share it.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Link,
  Outlet,
  useCanGoBack,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { browserName, share, type Session } from '../pairing/connect'
import { Pairing } from '../pairing/Pairing'
import { AppError, toAppError } from '../../errors'
import { ErrorView } from '../../ErrorView'
import { tunnelFetch, tunnelJson, tunnelLines } from '../../tunnel'
import { event } from '../../diag'
import type { Screen, ScreenCommand, ScreenState } from '../gateways/api'
import { Player } from './Player'
import {
  audioTracks,
  clock,
  isBack,
  subtitleTracks,
  TICKS_PER_SECOND,
  type Item,
} from './items'
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
  const [err, setErr] = useState<AppError | null>(null)
  const [attempt, setAttempt] = useState(0) // bumped after an inline re-pair

  useEffect(() => {
    const { session, release } = share(gatewayId)
    let gone = false
    session.then(
      (x) => {
        if (gone) return
        x.speed() // measure on first use, once per session (#162)
        setSession(x)
      },
      (e) => setErr(toAppError(e)),
    )
    return () => {
      gone = true
      release()
    }
  }, [gatewayId, attempt])

  return (
    <section>
      <p style={{ display: 'flex', justifyContent: 'space-between' }}>
        <Link to="/">← Gateways</Link>
        <Link to="/g/$gatewayId/screen" params={{ gatewayId }}>
          Use as screen
        </Link>
      </p>
      {err && (
        <ErrorView
          error={err}
          // Evicted client key (#174) or a new gateway cert: pair right here,
          // then reconnect (no reload: it would wipe the diagnostics log).
          pair={
            <Pairing
              gatewayId={gatewayId}
              lanUrl={null}
              onPaired={() => {
                setErr(null)
                setAttempt((n) => n + 1)
              }}
            />
          }
        />
      )}
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
  const [err, setErr] = useState<AppError | null>(null)
  useEffect(() => {
    tunnelJson<Item>(pc, `/Items/${itemId}`).then(setItem, (e) =>
      setErr(toAppError(e)),
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
  if (err) return <ErrorView error={err} />
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

// Screen mode (#180, docs/protocol.md "Screens"): this device holds GET
// /streamiq/screen and plays what a phone on the same gateway sends. The screen
// lives as long as this view: leaving it (Back, tab closed) closes the channel,
// which removes the screen on the gateway; leaving the gateway frees the
// shared session. No devtools on a TV: everything goes to the diagnostics log.
export function ScreenPage() {
  const { gatewayId, pc, speed } = useContext(Tunnel)
  const navigate = useNavigate()
  const [play, setPlay] = useState<{
    itemId: string
    startTicks?: number
    n: number
  } | null>(null)
  const [ended, setEnded] = useState<string | null>(null)
  const players = useRef(new Set<(c: ScreenCommand) => void>())
  // Commands after a play, before its Player subscribes: applied on subscribe.
  const early = useRef<ScreenCommand[] | null>(null)
  const remote = useCallback((apply: (c: ScreenCommand) => void) => {
    players.current.add(apply)
    early.current?.forEach(apply)
    early.current = null
    return () => void players.current.delete(apply)
  }, [])
  // State to the gateway (#181): one POST at a time, in order; while one is
  // out, only the newest waits.
  const post = useMemo(() => {
    let busy = false
    let next: ScreenState | null = null
    const go = (s: ScreenState) => {
      next = s
      if (busy) return
      busy = true
      next = null
      tunnelFetch(pc, '/streamiq/screen/state', {
        method: 'POST',
        body: JSON.stringify(s),
      })
        .catch(() => {})
        .finally(() => {
          busy = false
          if (next) go(next)
        })
    }
    return go
  }, [pc])
  const router = useRouter()
  const canGoBack = useCanGoBack()
  // Pops the screen off history (or replaces it), so a later Back never
  // lands on it and reopens a screen the user didn't choose.
  const leave = useCallback(
    () =>
      canGoBack
        ? router.history.back()
        : navigate({
            to: '/g/$gatewayId',
            params: { gatewayId },
            replace: true,
          }),
    [router, canGoBack, navigate, gatewayId],
  )
  useEffect(() => {
    const active = () =>
      (navigator as { userActivation?: { hasBeenActive: boolean } })
        .userActivation?.hasBeenActive ?? '?'
    event(
      `screen: open · ${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? navigator.userAgent} · user activation ${active()}`,
    )
    // Screen saver / power saving may freeze the page: log for how long.
    let last = Date.now()
    const watchdog = setInterval(() => {
      const gap = Date.now() - last
      if (gap > 30_000)
        event(`screen: page frozen ~${Math.round(gap / 1000)} s`)
      last = Date.now()
    }, 5_000)
    let n = 0
    const close = tunnelLines(
      pc,
      '/streamiq/screen',
      (line) => {
        const c = JSON.parse(line) as ScreenCommand
        event(`screen: ${c.type} · user activation ${active()}`)
        if (c.type === 'play') {
          players.current.clear() // the old Player is on its way out
          early.current = []
          setPlay({ itemId: c.itemId, startTicks: c.startTicks, n: ++n })
        } else if (c.type === 'stop') {
          early.current = null
          setPlay(null)
        } else if (early.current) early.current.push(c)
        else players.current.forEach((apply) => apply(c))
      },
      (why) => {
        event(`screen: ended (${why})`)
        setEnded(why)
      },
    )
    return () => {
      clearInterval(watchdog)
      close()
    }
  }, [pc])
  useEffect(() => {
    if (!play) post(IDLE)
  }, [play, post])
  // The remote's Back on the waiting view; the player handles its own.
  useEffect(() => {
    if (play) return
    const key = (e: KeyboardEvent) => {
      if (!isBack(e)) return
      e.preventDefault() // else the browser's own Back runs too
      leave()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [play, leave])

  const name = browserName()
  return (
    <>
      {ended && (
        <p role="alert">
          Screen mode ended ({ended}). <Link to="/">Back to your gateways</Link>{' '}
          and open it again.
        </p>
      )}
      {play ? (
        <>
          <p>
            <small>📱 Controlled from your phone</small>
          </p>
          <Player
            key={play.n}
            pc={pc}
            speed={speed}
            itemId={play.itemId}
            startTicks={play.startTicks}
            remote={remote}
            onState={post}
            onExit={() => setPlay(null)}
          />
        </>
      ) : (
        !ended && (
          <>
            <h2>Screen: {name}</h2>
            <p>
              Open StreamIQ on your phone → Play on <b>{name}</b>
            </p>
            <button type="button" autoFocus onClick={leave}>
              Back
            </button>
          </>
        )
      )}
    </>
  )
}

// "Play on…" (#180): the gateway's open screens. Only a device in screen mode
// is one, so nothing else can be picked.
function PlayOn({ pc, item }: { pc: RTCPeerConnection; item: Item }) {
  const { gatewayId } = useContext(Tunnel)
  const navigate = useNavigate()
  const [screens, setScreens] = useState<Screen[] | null>(null)
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState('')
  const toggle = () => {
    setOpen(!open)
    setScreens(null)
    setMsg('')
    if (!open)
      tunnelJson<Screen[]>(pc, '/streamiq/screens').then(setScreens, (e) =>
        setMsg(toAppError(e).message),
      )
  }
  const send = (s: Screen) => {
    // No startTicks: the TV resumes from fresh UserData (this listing may be stale).
    const play: ScreenCommand = {
      type: 'play',
      itemId: item.Id,
    }
    tunnelJson(pc, `/streamiq/screens/${s.id}`, play).then(
      () =>
        navigate({
          to: '/g/$gatewayId/remote/$screenId',
          params: { gatewayId, screenId: s.id },
        }),
      (e) => setMsg(toAppError(e).message),
    )
  }
  return (
    <div>
      <button type="button" onClick={toggle} aria-expanded={open}>
        Play on…
      </button>
      {open &&
        screens &&
        (screens.length ? (
          screens.map((s) => (
            <p key={s.id}>
              <button type="button" onClick={() => send(s)}>
                {s.name}
              </button>{' '}
              {s.state?.itemId && (
                <Link
                  to="/g/$gatewayId/remote/$screenId"
                  params={{ gatewayId, screenId: s.id }}
                >
                  Remote
                </Link>
              )}
            </p>
          ))
        ) : (
          <p>
            <small>
              No screen open. On the TV, open this gateway in StreamIQ and
              choose “Use as screen”.
            </small>
          </p>
        ))}
      {msg && (
        <p>
          <small>{msg}</small>
        </p>
      )}
    </div>
  )
}

const IDLE: ScreenState = {
  itemId: '',
  positionTicks: 0,
  durationTicks: 0,
  paused: true,
  audio: null,
  subtitle: null,
}

// Phone remote view (#181): follows the screen's state (GET /streamiq/screens
// every second) and sends commands one at a time, in order (each POST is its
// own channel). Two phones see the same state; the last command wins.
export function RemotePage({ screenId }: { screenId: string }) {
  const { gatewayId, pc } = useContext(Tunnel)
  const [screen, setScreen] = useState<Screen | null>() // null: closed
  const [item, setItem] = useState<Item | null>(null)
  const [drag, setDrag] = useState<number | null>(null) // seek bar, seconds
  const dragging = useRef(0)
  const [msg, setMsg] = useState('')
  useEffect(() => {
    let gone = false
    let t = 0
    const poll = () =>
      tunnelJson<Screen[]>(pc, '/streamiq/screens').then(
        (l) => {
          if (gone) return
          const s = l.find((x) => x.id === screenId) ?? null
          setScreen(s)
          setMsg('')
          if (s) t = window.setTimeout(poll, 1000) // closed: ids never come back
        },
        (e) => {
          if (gone) return
          setMsg(toAppError(e).message)
          t = window.setTimeout(poll, 1000)
        },
      )
    poll()
    return () => {
      gone = true
      clearTimeout(t)
    }
  }, [pc, screenId])
  const st = screen?.state
  const itemId = st?.itemId
  useEffect(() => {
    setItem(null)
    if (itemId) tunnelJson<Item>(pc, `/Items/${itemId}`).then(setItem, () => {})
  }, [pc, itemId])
  // A drag sends many seeks: a queued seek is replaced by the newer one.
  const [send] = useState(() => {
    const q: ScreenCommand[] = []
    let busy = false
    const next = () => {
      const c = q.shift()
      busy = !!c
      if (c)
        tunnelJson(pc, `/streamiq/screens/${screenId}`, c)
          .catch((e) => setMsg(toAppError(e).message))
          .finally(next)
    }
    return (c: ScreenCommand) => {
      if (c.type === 'seek' && q.at(-1)?.type === 'seek') q.pop()
      q.push(c)
      if (!busy) next()
    }
  })

  if (screen === undefined) return <p>Connecting to the screen…</p>
  const library = (
    <Link to="/g/$gatewayId" params={{ gatewayId }}>
      Library
    </Link>
  )
  if (!screen) return <p role="alert">Screen closed. {library}</p>
  const pos = (st?.positionTicks ?? 0) / TICKS_PER_SECOND
  const dur = (st?.durationTicks ?? 0) / TICKS_PER_SECOND
  const seek = (t: number) => {
    t = Math.max(0, dur ? Math.min(dur, t) : t)
    setDrag(t) // until the TV's state catches up
    clearTimeout(dragging.current)
    dragging.current = window.setTimeout(() => setDrag(null), 2000)
    send({ type: 'seek', ticks: Math.floor(t * TICKS_PER_SECOND) })
  }
  const audio = audioTracks(item?.MediaStreams)
  const subs = subtitleTracks(item?.MediaStreams)
  return (
    <>
      <h2>Remote: {screen.name}</h2>
      {!st?.itemId ? (
        <p>Nothing playing. {library}</p>
      ) : (
        <>
          <h3>{item?.Name}</h3>
          <p>
            <input
              type="range"
              aria-label="Position"
              min={0}
              max={Math.max(dur, 1)}
              step={1}
              value={drag ?? pos}
              onChange={(e) => seek(Number(e.target.value))}
              style={{ width: '100%' }}
            />
            <small>
              {clock(drag ?? pos)} / {clock(dur)}
            </small>
          </p>
          <p>
            <button type="button" onClick={() => seek(pos - 10)}>
              −10 s
            </button>{' '}
            <button
              type="button"
              onClick={() => send({ type: st.paused ? 'resume' : 'pause' })}
            >
              {st.paused ? 'Play' : 'Pause'}
            </button>{' '}
            <button type="button" onClick={() => seek(pos + 10)}>
              +10 s
            </button>{' '}
            <button type="button" onClick={() => send({ type: 'stop' })}>
              Stop
            </button>
          </p>
          {audio.length > 1 && (
            <label>
              Audio{' '}
              <select
                value={String(st.audio ?? '')}
                onChange={(e) =>
                  send({ type: 'tracks', audio: Number(e.target.value) })
                }
              >
                {st.audio == null && <option value="">Default</option>}
                {audio.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}{' '}
          {subs.length > 1 && (
            <label>
              Subtitles{' '}
              <select
                value={String(st.subtitle ?? -1)}
                onChange={(e) =>
                  send({ type: 'tracks', subtitle: Number(e.target.value) })
                }
              >
                {subs.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
      {msg && (
        <p>
          <small>{msg}</small>
        </p>
      )}
    </>
  )
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
  const [err, setErr] = useState<AppError | null>(null)

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
    load.then(setRows, (e) => setErr(toAppError(e)))
  }, [pc, view])

  if (err) return <ErrorView error={err} />
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
                    {playable(i) && <PlayOn pc={pc} item={i} />}
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
