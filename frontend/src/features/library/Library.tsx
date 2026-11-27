// Library browsing over the tunnel: the gateway shell (GatewayLibrary), the item
// page (title, seasons, folders, inline playback) and the player page; home lives
// in Home.tsx.
// Routes (App.tsx): /g/$gatewayId owns the tunnel; its children (home, /i, /play,
// /screen, /remote) render through <Outlet /> and share it.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PageBar } from '../../shared/PageBar'
import { useBack } from '../../shared/slots'
import {
  Outlet,
  useCanGoBack,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { share, type Session } from '../pairing/connect'
import { hold } from '../pairing/hold'
import { event } from '../../shared/diag'
import { Pairing } from '../pairing/Pairing'
import { AppError, toAppError } from '../../shared/errors'
import { ErrorView, State } from '../../shared/ErrorView'
import * as jf from './jellyfin'
import { useHousehold } from '../households/household'
import { guestNotice } from './guest'
import { Player } from '../player/Player'
import {
  folderUp,
  inProgress,
  pageItem,
  playable,
  playLabel,
  playsAtOnce,
  progress,
  runtime,
  titleInfo,
  upNext,
  type Item,
} from './items'
import { LiveRoute } from '../gateways/Badge'
import { connKey, type Conn } from '../gateways/connection'
import { useQueryClient } from '@tanstack/react-query'
import { useGuestStatus } from './queries'
import { PlayOn } from '../screen/Screen'
import { arrowFocus } from '../../shared/focus'
import {
  Tunnel,
  backdrop,
  current,
  primary,
  usePlay,
  useTunnel,
  useFolderPages,
  useTunnelQuery,
} from './art'
import { folderView } from './paging'
import { Artwork, Watched, YearLine } from './Home'
import { Favorite } from './Favorite'
import { tvOn } from '../../shared/settings'
export { Home as LibraryHome } from './Home'

// Layout route: the gateway's shared tunnel, held while navigating inside
// it; leaving releases it (closed 30 s later unless reused).
export function GatewayLibrary({ gatewayId }: { gatewayId: string }) {
  const [session, setSession] = useState<Session | null>(null)
  const [err, setErr] = useState<AppError | null>(null)
  const [attempt, setAttempt] = useState(0) // bumped after an inline re-pair
  const qc = useQueryClient()

  // A dropped tunnel is replaced by a new one: the pages keep showing
  // until it is up, then get its pc.
  useEffect(
    () =>
      hold(gatewayId, share, {
        up: setSession,
        dropped: () => {
          event('tunnel dropped: reconnecting')
          // the shell badge, until the new tunnel's route
          qc.setQueryData<Conn>(connKey(gatewayId), { route: 'reconnecting' })
        },
        error: (e) => {
          const err = toAppError(e)
          setSession(null) // a drop that won't reconnect: off the dead pc
          setErr(err)
          qc.setQueryData<Conn>(connKey(gatewayId), {
            route: err.kind === 'not-paired' ? 'unpaired' : 'failed',
          }) // the shell badge
        },
      }),
    [gatewayId, attempt, qc],
  )

  return (
    // D-pad: the whole library, the not-paired block included; the
    // player moves its own focus (Controls.tsx).
    <section
      onKeyDown={(e) =>
        !(e.target as Element).closest('.player') && arrowFocus(e)
      }
    >
      {session && <LiveRoute gatewayId={gatewayId} pc={session.pc} />}
      {err && (
        <ErrorView
          error={err}
          focus
          // Evicted client key or a new gateway cert: pair right here,
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
          <Guest />
          <Outlet />
        </Tunnel.Provider>
      )}
    </section>
  )
}

// Folder / series / movie or other video by Jellyfin item ID, so a reload or deep link
// restores it. A season opens its series' page on that season's tab.
export function ItemPage({ itemId, play }: { itemId: string; play?: string }) {
  const it = useTunnelQuery<Item>(jf.item(itemId))
  const seriesId = it.data?.Type === 'Season' ? it.data.SeriesId : undefined
  const series = useTunnelQuery<Item>(seriesId ? jf.item(seriesId) : null)
  const error = it.error ?? series.error
  const shown = it.data ? pageItem(it.data, series.data) : null
  if (error && !shown) return <ErrorView error={toAppError(error)} focus />
  if (!shown)
    return (
      <div className="title" role="status" aria-label="Loading">
        <div className="title-top">
          <div className="ph hero" />
          <div className="title-info">
            <div className="ph ph-h1" />
            <div className="ph ph-line" />
            <div className="ph ph-line short" />
          </div>
        </div>
        <EpisodesPlaceholder />
      </div>
    )
  const { item, season } = shown
  if (item.Type === 'Series' || playable(item))
    return (
      <Title
        item={item}
        season={season}
        updatedAt={it.dataUpdatedAt}
        playing={tvOn() ? undefined : play} // TV mode: the player page only
      />
    )
  return <Browse item={item} />
}

// The title's info column: the heart, the facts line, the overview and
// genres (phone: behind More), then `children` (Play on…).
function TitleInfo({
  item,
  seasons,
  children,
}: {
  item: Item
  seasons?: number
  children: ReactNode
}) {
  const [more, setMore] = useState(false)
  const info = titleInfo(item, seasons)
  const genres = item.Genres ?? []
  const hasMore = !!item.Overview || genres.length > 1
  return (
    <div className="title-info">
      <Favorite item={item} />
      {info && <p className="muted">{info}</p>}
      {hasMore && (
        <button
          type="button"
          className="phone-only more-toggle"
          aria-expanded={more}
          onClick={() => setMore(!more)}
        >
          {more ? 'Less' : 'More'}
        </button>
      )}
      {hasMore && (
        <div className={more ? 'title-more open' : 'title-more'}>
          {item.Overview && <p className="overview">{item.Overview}</p>}
          {genres.length > 1 && <p className="muted">{genres.join(', ')}</p>}
        </div>
      )}
      {children}
    </div>
  )
}

function EpisodesPlaceholder() {
  return (
    <div className="episodes" role="status" aria-label="Loading">
      {[0, 1, 2].map((n) => (
        <div key={n} className="ph ph-ep" />
      ))}
    </div>
  )
}

const seasonName = (s: Item) =>
  s.Name || (s.IndexNumber != null ? `Season ${s.IndexNumber}` : 'Season')

// Series / movie / other video page: the hero card plays (first focus on
// load: one OK press plays; its Play / Resume on every size), the info column
// beside it (phone: under it, shortened, with More); a series adds its season
// tabs + episodes below. Nothing moves focus after that, on re-renders or tab
// changes. Data from before the last playback doesn't drive play: it waits for
// the refetch. Outside TV mode the video plays in the hero's place (?play=).
// oxlint-disable-next-line complexity -- render branching
function Title({
  item,
  season,
  updatedAt,
  playing,
}: {
  item: Item
  season?: string
  updatedAt: number
  playing?: string
}) {
  const { gatewayId, pc, speed } = useTunnel()
  const navigate = useNavigate()
  const series = item.Type === 'Series'
  const [tab, setTab] = useState(season)
  // ponytail: every episode in one request; per season if huge shows lag.
  const ss = useTunnelQuery<{ Items: Item[] }>(
    series ? jf.seasons(item.Id) : null,
  )
  const es = useTunnelQuery<{ Items: Item[] }>(
    series ? jf.episodes(item.Id) : null,
  )
  const lists = ss.data &&
    es.data && { seasons: ss.data.Items, episodes: es.data.Items }
  const failed = ss.error ?? es.error
  const err = failed && !lists ? toAppError(failed) : null

  const { play, stop } = useInline()
  const back = useBack(() =>
    navigate({ to: '/g/$gatewayId', params: { gatewayId } }),
  )
  const next = series ? lists && upNext(lists.episodes) : item
  const ready = current(gatewayId, series ? es.dataUpdatedAt : updatedAt)
  const go = next && ready ? next : null
  const now = lists?.episodes.find((e) => e.Id === playing)
  const shown = tab ?? now?.SeasonId ?? next?.SeasonId ?? lists?.seasons[0]?.Id
  const episodes = lists?.episodes.filter((e) => e.SeasonId === shown) ?? []
  const art = (
    <Artwork
      art={backdrop(item) ?? primary(item)}
      card={item}
      width={1280}
      className="hero-art"
    />
  )

  return (
    <div className="title">
      <PageBar title={item.Name} onBack={back} />
      <div className="title-top">
        {playing ? (
          <div className="hero hero-player">
            <Player
              key={playing}
              pc={pc}
              speed={speed}
              itemId={playing}
              onExit={stop}
              onEnded={stop}
              inline
              onNext={play}
            />
          </div>
        ) : go ? (
          <button
            type="button"
            className="hero"
            autoFocus
            onClick={() => play(go)}
          >
            {art}
            <span className="hero-play">
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M7 4v16l13-8z" />
              </svg>
              {playLabel(go)}
            </span>
          </button>
        ) : (
          <div className="hero">{art}</div>
        )}
        <TitleInfo item={item} seasons={lists?.seasons.length}>
          {go && <PlayOn pc={pc} item={go} />}
        </TitleInfo>
      </div>
      {series && (
        <div className="title-main">
          {err && <ErrorView error={err} />}
          {!lists && !err && <EpisodesPlaceholder />}
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
          {lists && !episodes.length && (
            <State icon="empty" title="Nothing here." />
          )}
          {lists && !!episodes.length && (
            <ul
              id="episodes"
              role="tabpanel"
              aria-labelledby={`tab-${shown}`}
              className="episodes"
            >
              {episodes.map((e) => (
                <li key={e.Id} className="ep-row">
                  <Episode item={e} onPlay={play} />
                  <PlayOn pc={pc} item={e} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function Episode({ item, onPlay }: { item: Item; onPlay: (i: Item) => void }) {
  const state = progress(item)
  return (
    <button type="button" className="episode" onClick={() => onPlay(item)}>
      <span className="still">
        <Artwork
          art={primary(item)}
          card={item}
          width={352}
          className="still-art"
        />
        {inProgress(item) && <Watched item={item} />}
      </span>
      <span className="ep-text">
        <b>
          {item.IndexNumber != null && `${item.IndexNumber}. `}
          {item.Name}
        </b>
        {runtime(item) && <small className="muted">{runtime(item)}</small>}
      </span>
      {state && (
        <small className={item.UserData?.Played ? 'muted' : 'ep-left'}>
          {state}
        </small>
      )}
    </button>
  )
}

// Play / stop on the detail page. Outside TV mode ?play= replaces this entry
// either way, so Back leaves the page in one step.
function useInline() {
  const { gatewayId } = useTunnel()
  const navigate = useNavigate()
  const play = (i: Item) =>
    tvOn()
      ? navigate({
          to: '/g/$gatewayId/play/$itemId',
          params: { gatewayId, itemId: i.Id },
        })
      : navigate({ to: '.', search: { play: i.Id }, replace: true })
  const stop = () => navigate({ to: '.', search: {}, replace: true })
  return { play, stop }
}

// Player route: leaving it any way unmounts the Player, whose cleanup saves the
// position. Back goes back in history; after a deep link (no in-app history)
// it goes to the item's listing instead of leaving the app.
export function PlayerPage({ itemId }: { itemId: string }) {
  const { gatewayId, pc, speed } = useTunnel()
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
  // Next episode: replaces this entry, so Back still leaves the player.
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

// A folder: its name + Back in the title row, the listing as a grid.
function Browse({ item }: { item: Item }) {
  const { gatewayId } = useTunnel()
  const navigate = useNavigate()
  const play = usePlay()
  const up = folderUp(item)
  const back = useBack(() =>
    navigate(
      up
        ? { to: '/g/$gatewayId/i/$itemId', params: { gatewayId, itemId: up } }
        : { to: '/g/$gatewayId', params: { gatewayId } },
    ),
  )
  const open = (i: Item) =>
    playsAtOnce(i)
      ? play(i)
      : navigate({
          to: '/g/$gatewayId/i/$itemId',
          params: { gatewayId, itemId: i.Id },
        })

  return (
    <>
      <PageBar title={item.Name} onBack={back} />
      <Listing item={item} onOpen={open} />
    </>
  )
}

function Listing({ item, onOpen }: { item: Item; onOpen: (i: Item) => void }) {
  const q = useFolderPages(item.Id)
  const view = folderView({
    pages: q.data?.pages,
    hasNext: q.hasNextPage,
    nextFailed: q.isFetchNextPageError,
    fetching: q.isFetchingNextPage,
  })
  if (q.error && !view) return <ErrorView error={toAppError(q.error)} focus />
  if (!view)
    return (
      <ul className="poster-grid" role="status" aria-label="Loading">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
          <li key={n}>
            <div className="ph poster" />
            <div className="ph ph-line" />
          </li>
        ))}
      </ul>
    )
  const { items, tail } = view
  if (!items.length) return <State icon="empty" title="Nothing here." />
  // cancelRefetch false: a second call while a page loads is a no-op
  const more = () => void q.fetchNextPage({ cancelRefetch: false })
  return (
    <>
      <ul className="poster-grid">
        {items.map((i) => (
          <li key={i.Id}>
            <button
              type="button"
              onClick={() => onOpen(i)}
              className="poster-tile"
            >
              <span className="poster-box">
                <Artwork
                  art={primary(i)}
                  card={i}
                  width={280}
                  className="poster"
                />
                {(inProgress(i) || i.UserData?.Played) && <Watched item={i} />}
              </span>
              <span className="card-line">
                {i.IndexNumber != null &&
                  i.Type === 'Episode' &&
                  `${i.IndexNumber}. `}
                {i.Name}
              </span>
              <YearLine item={i} />
            </button>
          </li>
        ))}
      </ul>
      {tail === 'retry' && <ErrorView error={q.error} onRetry={more} />}
      {tail === 'loading' && (
        <div className="ph ph-line" role="status" aria-label="Loading" />
      )}
      {tail === 'more' && <OnScreen key={items.length} onShow={more} />}
    </>
  )
}

/** Calls onShow once it is near the viewport (keyed per page: a new observer
 * reports at once, so a short page that leaves it on screen loads on). */
function OnScreen({ onShow }: { onShow: () => void }) {
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const io = new IntersectionObserver(
      (es) => es.some((e) => e.isIntersecting) && onShow(),
      { rootMargin: '600px' },
    )
    if (el.current) io.observe(el.current)
    return () => io.disconnect()
  }, [onShow])
  return <div ref={el} />
}

// Guest-mode banner, on the library and the player. ponytail: checked
// once per visit, though the gateway picks the viewer per request; a viewer
// made or dropped mid-visit shows on the next one.
// No status (older gateway, error) = no banner.
function Guest() {
  const { gatewayId, pc } = useTunnel()
  const admin = useHousehold().current?.role === 'admin'
  const s = useGuestStatus(gatewayId, pc)
  const notice = guestNotice(s, admin)
  return notice && <p role="status">{notice}</p>
}
