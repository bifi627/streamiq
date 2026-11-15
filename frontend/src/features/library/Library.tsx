// Library browsing over the tunnel (MVP item 5, consumption only). Functional,
// not pretty: the UI is refactored later. Routes (App.tsx): /g/$gatewayId owns the
// tunnel; its children (home, /i/$itemId) render through <Outlet /> and share it.
import {
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
  useRouterState,
} from '@tanstack/react-router'
import { browserName, share, type Session } from '../pairing/connect'
import { Pairing } from '../pairing/Pairing'
import { AppError, toAppError } from '../../errors'
import { ErrorView } from '../../ErrorView'
import { tunnelFetch, tunnelJson, tunnelLines } from '../../tunnel'
import { event } from '../../diag'
import type {
  GatewayStatus,
  Screen,
  ScreenCommand,
  ScreenState,
} from '../gateways/api'
import { useHousehold } from '../households/household'
import { guestNotice } from './guest'
import { Player } from './Player'
import {
  audioTracks,
  clock,
  isBack,
  playable,
  playsAtOnce,
  subtitleTracks,
  TICKS_PER_SECOND,
  upNext,
  type Item,
} from './items'
import { Privacy } from './Privacy'
import { ICON, Icon } from './Controls'
import { arrowFocus } from '../../focus'
import { Tunnel, backdrop, primary } from './art'
import { Artwork, minutes, Watched } from './Home'
export { Home as LibraryHome } from './Home'

type Page = { Items: Item[] }

// Layout route: the gateway's shared tunnel (#152), held while navigating inside
// it; leaving releases it (closed 30 s later unless reused).
export function GatewayLibrary({ gatewayId }: { gatewayId: string }) {
  const [session, setSession] = useState<Session | null>(null)
  const [err, setErr] = useState<AppError | null>(null)
  const [attempt, setAttempt] = useState(0) // bumped after an inline re-pair
  // The player has its own badge in its overlay (#205).
  const playing = useRouterState({
    select: (r) => r.location.pathname.includes('/play/'),
  })
  const screenMode = useRouterState({
    select: (r) => r.location.pathname.endsWith('/screen'),
  })

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
    // D-pad (#203): the whole library, the not-paired block included; the
    // player moves its own focus (Controls.tsx).
    <section
      onKeyDown={(e) =>
        !(e.target as Element).closest('.player') && arrowFocus(e)
      }
    >
      <p className="lib-top">
        <Link to="/gateways">← Gateways</Link>
        <span className="lib-actions">
          {session && !playing && !screenMode && <Privacy pc={session.pc} />}
          {!screenMode && (
            <Link to="/g/$gatewayId/screen" params={{ gatewayId }}>
              Use as screen
            </Link>
          )}
        </span>
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
              needsPair
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
          <Guest pc={session.pc} />
          <Outlet />
        </Tunnel.Provider>
      )}
    </section>
  )
}

// Folder / series / movie by Jellyfin item ID, so a reload or deep link
// restores it. A season opens its series' page on that season's tab (#204).
export function ItemPage({ itemId }: { itemId: string }) {
  const { pc } = useContext(Tunnel)
  const [shown, setShown] = useState<{ item: Item; season?: string } | null>(
    null,
  )
  const [err, setErr] = useState<AppError | null>(null)
  useEffect(() => {
    tunnelJson<Item>(pc, `/Items/${itemId}`)
      .then((i) =>
        i.Type === 'Season' && i.SeriesId
          ? tunnelJson<Item>(pc, `/Items/${i.SeriesId}`).then((s) => ({
              item: s,
              season: i.Id,
            }))
          : { item: i },
      )
      .then(setShown, (e) => setErr(toAppError(e)))
  }, [pc, itemId])
  if (err) return <ErrorView error={err} />
  if (!shown) return <p>Loading…</p>
  const { item, season } = shown
  if (item.Type === 'Series' || item.Type === 'Movie')
    return <Title item={item} season={season} />
  return <Browse item={item} />
}

const seasonName = (s: Item) =>
  s.Name || (s.IndexNumber != null ? `Season ${s.IndexNumber}` : 'Season')

// Series / movie page (#204): the left column (poster, title, meta, overview,
// the one primary button); a series adds season tabs + its episodes, a movie
// its backdrop. The primary button takes first focus (one OK press plays);
// nothing moves focus after that, on re-renders or tab changes.
function Title({ item, season }: { item: Item; season?: string }) {
  const { gatewayId, pc } = useContext(Tunnel)
  const navigate = useNavigate()
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const series = item.Type === 'Series'
  const [lists, setLists] = useState<{ seasons: Item[]; episodes: Item[] }>()
  const [err, setErr] = useState<AppError | null>(null)
  const [tab, setTab] = useState(season)
  useEffect(() => {
    if (!series) return
    const get = (url: string) => tunnelJson<Page>(pc, url).then((p) => p.Items)
    // ponytail: every episode in one request; per season if huge shows lag.
    Promise.all([
      get(`/Shows/${item.Id}/Seasons`),
      get(`/Shows/${item.Id}/Episodes`),
    ]).then(
      ([seasons, episodes]) => setLists({ seasons, episodes }),
      (e) => setErr(toAppError(e)),
    )
  }, [pc, item.Id, series])

  const play = (i: Item) =>
    navigate({
      to: '/g/$gatewayId/play/$itemId',
      params: { gatewayId, itemId: i.Id },
    })
  const back = () =>
    canGoBack
      ? router.history.back()
      : navigate({ to: '/g/$gatewayId', params: { gatewayId } })
  const next = series ? lists && upNext(lists.episodes) : item
  const resumes =
    !!next &&
    !next.UserData?.Played &&
    (next.UserData?.PlaybackPositionTicks ?? 0) > 0
  const where =
    next && series
      ? ` S${next.ParentIndexNumber ?? '?'} · E${next.IndexNumber ?? '?'}`
      : ''
  const shown = tab ?? next?.SeasonId ?? lists?.seasons[0]?.Id
  const count = lists?.seasons.length
  const meta = [
    item.ProductionYear,
    series
      ? count && `${count} ${count === 1 ? 'season' : 'seasons'}`
      : item.RunTimeTicks &&
        minutes.format(Math.round(item.RunTimeTicks / TICKS_PER_SECOND / 60)),
    item.Genres?.[0],
  ].filter(Boolean)

  return (
    <div className="title">
      <div className="title-side">
        <button type="button" className="back" onClick={back}>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M15 6l-6 6 6 6" />
          </svg>
          Back
        </button>
        <Artwork art={primary(item)} width={360} className="title-poster" />
        <h1>{item.Name}</h1>
        {meta.length > 0 && <p className="muted">{meta.join(' · ')}</p>}
        {item.Overview && <p className="overview">{item.Overview}</p>}
        {next && (
          <>
            <button
              type="button"
              className="primary"
              autoFocus
              onClick={() => play(next)}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M7 4v16l13-8z" />
              </svg>
              {resumes ? 'Resume' : 'Play'}
              {where}
            </button>
            <PlayOn pc={pc} item={next} />
          </>
        )}
      </div>
      {series ? (
        <div className="title-main">
          {err && <ErrorView error={err} />}
          {!lists && !err && <p>Loading…</p>}
          {lists && lists.seasons.length > 0 && (
            <div role="tablist" aria-label="Seasons" className="seasons">
              {lists.seasons.map((s) => (
                <button
                  key={s.Id}
                  type="button"
                  role="tab"
                  id={`tab-${s.Id}`}
                  aria-selected={s.Id === shown}
                  aria-controls="episodes"
                  tabIndex={s.Id === shown ? 0 : -1}
                  onClick={() => setTab(s.Id)} // Enter: passing over a tab doesn't switch
                >
                  {seasonName(s)}
                </button>
              ))}
            </div>
          )}
          {lists && (
            <ul
              id="episodes"
              role="tabpanel"
              aria-labelledby={`tab-${shown}`}
              className="episodes"
            >
              {lists.episodes
                .filter((e) => e.SeasonId === shown)
                .map((e) => (
                  <li key={e.Id} className="ep-row">
                    <Episode item={e} onPlay={play} />
                    <PlayOn pc={pc} item={e} />
                  </li>
                ))}
            </ul>
          )}
        </div>
      ) : (
        backdrop(item) && (
          <Artwork
            art={backdrop(item)}
            width={1280}
            className="title-backdrop"
          />
        )
      )}
    </div>
  )
}

function Episode({ item, onPlay }: { item: Item; onPlay: (i: Item) => void }) {
  const pos = item.UserData?.PlaybackPositionTicks ?? 0
  const state = item.UserData?.Played
    ? 'Watched'
    : pos > 0 && item.RunTimeTicks
      ? `${minutes.format(Math.max(1, Math.round((item.RunTimeTicks - pos) / TICKS_PER_SECOND / 60)))} left`
      : ''
  return (
    <button type="button" className="episode" onClick={() => onPlay(item)}>
      <span className="still">
        <Artwork art={primary(item)} width={352} className="still-art" />
        {pos > 0 && !item.UserData?.Played && <Watched item={item} />}
      </span>
      <span className="ep-text">
        <b>
          {item.IndexNumber != null && `${item.IndexNumber}. `}
          {item.Name}
        </b>
        {!!item.RunTimeTicks && (
          <small className="muted">
            {minutes.format(
              Math.round(item.RunTimeTicks / TICKS_PER_SECOND / 60),
            )}
          </small>
        )}
      </span>
      {state && (
        <small className={item.UserData?.Played ? 'muted' : 'ep-left'}>
          {state}
        </small>
      )}
    </button>
  )
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
  // Next episode (#205): replaces this entry, so Back still leaves the player.
  const next = (i: Item) =>
    navigate({
      to: '/g/$gatewayId/play/$itemId',
      params: { gatewayId, itemId: i.Id },
      replace: true,
    })
  return (
    <Player pc={pc} speed={speed} itemId={itemId} onExit={back} onNext={next} />
  )
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
  // Commands between a play and its Player's subscribe, replayed to it
  // (StrictMode subscribes twice in one commit); then null: live only.
  const since = useRef<ScreenCommand[] | null>(null)
  const remote = useCallback((apply: (c: ScreenCommand) => void) => {
    players.current.add(apply)
    const early = since.current
    early?.forEach(apply)
    setTimeout(() => {
      if (since.current === early) since.current = null
    })
    return () => void players.current.delete(apply)
  }, [])
  // State to the gateway (#181): one POST at a time, in order; while one is
  // out, only the newest waits.
  const post = useMemo(
    () =>
      serial(
        (s: ScreenState) =>
          tunnelFetch(pc, '/streamiq/screen/state', {
            method: 'POST',
            body: JSON.stringify(s),
          }),
        () => true,
      ),
    [pc],
  )
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
          since.current = []
          setPlay({ itemId: c.itemId, startTicks: c.startTicks, n: ++n })
        } else if (c.type === 'stop') setPlay(null)
        else {
          since.current?.push(c)
          players.current.forEach((apply) => apply(c))
        }
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
          Screen mode ended ({ended}).{' '}
          <Link to="/gateways">Back to your gateways</Link> and open it again.
        </p>
      )}
      {play ? (
        <>
          <p className="muted">
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
          // Read from the couch (#227): big, centered, one action.
          <div className="screen-wait">
            <Icon d={ICON.tv} />
            <h2>Screen: {name}</h2>
            <ol>
              <li>Open StreamIQ on your phone</li>
              <li>Pick something to watch</li>
              <li>
                Play on <b>{name}</b>
              </li>
            </ol>
            <button type="button" autoFocus onClick={leave}>
              Leave
            </button>
          </div>
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
    // A secondary action under the tile (#227): outlined, not filled.
    <div className="play-on">
      <button
        type="button"
        className="secondary"
        onClick={toggle}
        aria-expanded={open}
      >
        <Icon d={ICON.cast} />
        Play on…
      </button>
      {open &&
        screens &&
        (screens.length ? (
          <ul>
            {screens.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => send(s)}>
                  {s.name}
                </button>
                {s.state?.itemId && (
                  <Link
                    to="/g/$gatewayId/remote/$screenId"
                    params={{ gatewayId, screenId: s.id }}
                  >
                    Remote
                  </Link>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">
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

/** Runs one at a time, in order (each tunnel POST is its own channel, so only
 * waiting keeps them ordered). A new x replaces the queued last one if
 * replaces(last, x). */
function serial<T>(
  run: (x: T) => Promise<unknown>,
  replaces: (queued: T, x: T) => boolean,
) {
  const q: T[] = []
  let busy = false
  const next = () => {
    busy = q.length > 0
    if (busy)
      run(q.shift()!)
        .catch(() => {})
        .finally(next)
  }
  return (x: T) => {
    if (q.length && replaces(q[q.length - 1], x)) q.pop()
    q.push(x)
    if (!busy) next()
  }
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
  const [fetched, setFetched] = useState<Item | null>(null)
  const [drag, setDrag] = useState<number | null>(null) // seek bar, seconds
  const dragging = useRef(0)
  const [msg, setMsg] = useState('') // the last command's error
  const [down, setDown] = useState('') // the last poll's error
  useEffect(() => {
    let gone = false
    let t = 0
    const poll = () =>
      tunnelJson<Screen[]>(pc, '/streamiq/screens').then(
        (l) => {
          if (gone) return
          const s = l.find((x) => x.id === screenId) ?? null
          setScreen(s)
          setDown('')
          if (s) t = window.setTimeout(poll, 1000) // closed: ids never come back
        },
        (e) => {
          if (gone) return
          setDown(toAppError(e).message)
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
    if (itemId)
      tunnelJson<Item>(pc, `/Items/${itemId}`).then(setFetched, () => {})
  }, [pc, itemId])
  const item = fetched?.Id === itemId ? fetched : null // not a late answer for another item
  // A drag sends many seeks: a queued seek is replaced by the newer one.
  const send = useMemo(
    () =>
      serial(
        (c: ScreenCommand) =>
          tunnelJson(pc, `/streamiq/screens/${screenId}`, c).catch((e) =>
            setMsg(toAppError(e).message),
          ),
        (queued, c) => queued.type === 'seek' && c.type === 'seek',
      ),
    [pc, screenId],
  )

  if (screen === undefined)
    return <p className="remote">{down || 'Connecting to the screen…'}</p>
  const library = (
    <Link to="/g/$gatewayId" params={{ gatewayId }}>
      Library
    </Link>
  )
  if (!screen)
    return (
      <div className="remote">
        <p role="alert">Screen closed. {library}</p>
      </div>
    )
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
  const art = item && (backdrop(item) ?? primary(item))
  // Phone first (#227): one column, the keys low enough for a thumb.
  return (
    <div className="remote">
      <h2>
        <Icon d={ICON.tv} />
        Remote: {screen.name}
      </h2>
      {!st?.itemId ? (
        <p>Nothing playing. {library}</p>
      ) : (
        <>
          {/* always the box, empty until the art is known: the keys never jump */}
          <Artwork
            art={art}
            width={780}
            // no backdrop: the poster whole, not a band of it (#337)
            className={`art remote-art${item && !backdrop(item) ? ' whole' : ''}`}
          />
          <h3>{item?.Name}</h3>
          <input
            type="range"
            aria-label="Position"
            min={0}
            max={Math.max(dur, 1)}
            step={1}
            value={drag ?? pos}
            onChange={(e) => seek(Number(e.target.value))}
            className="seek"
          />
          <small className="remote-time">
            {clock(drag ?? pos)} / {clock(dur)}
          </small>
          <div className="remote-keys">
            <button type="button" onClick={() => seek((drag ?? pos) - 10)}>
              −10 s
            </button>
            <button
              type="button"
              className="primary"
              aria-label={st.paused ? 'Play' : 'Pause'}
              onClick={() => send({ type: st.paused ? 'resume' : 'pause' })}
            >
              <Icon d={st.paused ? ICON.play : ICON.pause} />
            </button>
            <button type="button" onClick={() => seek((drag ?? pos) + 10)}>
              +10 s
            </button>
          </div>
          <button
            type="button"
            className="secondary"
            onClick={() => send({ type: 'stop' })}
          >
            <Icon d={ICON.stop} />
            Stop
          </button>
          {audio.length > 1 && (
            <label>
              Audio
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
          )}
          {subs.length > 1 && (
            <label>
              Subtitles
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
      {(down || msg) && (
        <p>
          <small>{down || msg}</small>
        </p>
      )}
    </div>
  )
}

// A folder: breadcrumbs from the item itself + the listing.
function Browse({ item }: { item: Item }) {
  const { gatewayId, pc } = useContext(Tunnel)
  const navigate = useNavigate()
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
      to: playsAtOnce(i)
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
        {item.SeriesId &&
          item.SeriesId !== item.Id &&
          crumb(item.SeriesId, item.SeriesName ?? 'Series')}
        {crumb(item.Id, item.Name)}
      </p>
      <Listing pc={pc} item={item} onOpen={open} />
    </>
  )
}

function Listing({
  pc,
  item,
  onOpen,
}: {
  pc: RTCPeerConnection
  item: Item
  onOpen: (i: Item) => void
}) {
  const [items, setItems] = useState<Item[] | null>(null)
  const [err, setErr] = useState<AppError | null>(null)

  useEffect(() => {
    tunnelJson<Page>(pc, `/Items?parentId=${item.Id}&sortBy=SortName`).then(
      (p) => setItems(p.Items),
      (e) => setErr(toAppError(e)),
    )
  }, [pc, item.Id])

  if (err) return <ErrorView error={err} />
  if (!items) return <p>Loading…</p>
  return (
    <>
      {items.length === 0 && <p>Nothing here.</p>}
      <ul className="tiles">
        {items.map((i) => (
          <li key={i.Id}>
            <button type="button" onClick={() => onOpen(i)} className="tile">
              <Artwork art={primary(i)} width={280} className="poster" />
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
    </>
  )
}

// Guest-mode banner (#242), on the library and the player. ponytail: checked
// once per tunnel session, though the gateway picks the viewer per request; a
// viewer made or dropped mid-session shows on the next connection.
function Guest({ pc }: { pc: RTCPeerConnection }) {
  const admin = useHousehold().current?.role === 'admin'
  const [s, setS] = useState<GatewayStatus | null>(null)
  useEffect(() => {
    let live = true
    tunnelJson<GatewayStatus>(pc, '/streamiq/status').then(
      (r) => live && setS(r),
      () => {}, // ponytail: no status (older gateway, error) = no banner
    )
    return () => {
      live = false
    }
  }, [pc])
  const notice = guestNotice(s, admin)
  return notice && <p role="status">{notice}</p>
}

function label(i: Item) {
  if (!playable(i)) return i.Type
  const pos = i.UserData?.PlaybackPositionTicks ?? 0
  if (i.UserData?.Played) return 'Watched'
  return pos > 0 ? `Resume ${clock(pos / TICKS_PER_SECOND)}` : 'Play'
}
