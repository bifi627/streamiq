// Library browsing over the tunnel: the gateway shell (GatewayLibrary), the item
// page (title, seasons, folders) and the player page; home lives in Home.tsx.
// Routes (App.tsx): /g/$gatewayId owns the tunnel; its children (home, /i, /play,
// /screen, /remote) render through <Outlet /> and share it.
import { useContext, useEffect, useState } from 'react'
import {
  Link,
  Outlet,
  useCanGoBack,
  useNavigate,
  useRouter,
  useRouterState,
} from '@tanstack/react-router'
import { share, type Session } from '../pairing/connect'
import { Pairing } from '../pairing/Pairing'
import { AppError, toAppError } from '../../errors'
import { ErrorView, State } from '../../ErrorView'
import * as jf from './jellyfin'
import { useHousehold } from '../households/household'
import { guestNotice } from './guest'
import { Player } from './Player'
import {
  clock,
  playable,
  playsAtOnce,
  TICKS_PER_SECOND,
  upNext,
  type Item,
} from './items'
import { Privacy } from './Privacy'
import { useGuestStatus } from './queries'
import { PlayOn } from './Screen'
import { arrowFocus } from '../../focus'
import { tvOn } from '../../settings'
import { Tunnel, backdrop, current, primary, useTunnelQuery } from './art'
import { Artwork, minutes, Watched } from './Home'
export { Home as LibraryHome } from './Home'

// Layout route: the gateway's shared tunnel, held while navigating inside
// it; leaving releases it (closed 30 s later unless reused).
export function GatewayLibrary({ gatewayId }: { gatewayId: string }) {
  const [session, setSession] = useState<Session | null>(null)
  const [err, setErr] = useState<AppError | null>(null)
  const [attempt, setAttempt] = useState(0) // bumped after an inline re-pair
  // The player has its own badge in its overlay.
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
        x.speed() // measure on first use, once per session
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
    // D-pad: the whole library, the not-paired block included; the
    // player moves its own focus (Controls.tsx).
    <section
      onKeyDown={(e) =>
        !(e.target as Element).closest('.player') && arrowFocus(e)
      }
    >
      <p className="lib-top">
        <Link to="/gateways">← Gateways</Link>
        <span className="lib-actions">
          {session && !playing && !screenMode && (
            <Privacy gatewayId={gatewayId} pc={session.pc} />
          )}
          {/* Up front only in TV mode; every device keeps the gateway
              card's entry (Gateways.tsx). */}
          {!screenMode && tvOn() && (
            <Link to="/g/$gatewayId/screen" params={{ gatewayId }}>
              Use as screen
            </Link>
          )}
        </span>
      </p>
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

// Folder / series / movie by Jellyfin item ID, so a reload or deep link
// restores it. A season opens its series' page on that season's tab.
export function ItemPage({ itemId }: { itemId: string }) {
  const it = useTunnelQuery<Item>(jf.item(itemId))
  const seriesId = it.data?.Type === 'Season' ? it.data.SeriesId : undefined
  const series = useTunnelQuery<Item>(seriesId ? jf.item(seriesId) : null)
  const error = it.error ?? series.error
  const shown = !it.data
    ? null
    : !seriesId
      ? { item: it.data }
      : series.data && { item: series.data, season: it.data.Id }
  if (error && !shown) return <ErrorView error={toAppError(error)} focus />
  if (!shown)
    return (
      <div className="title" role="status" aria-label="Loading">
        <div className="title-side">
          <div className="ph title-poster" />
          <div className="ph ph-h1" />
          <div className="ph ph-line" />
          <div className="ph ph-line short" />
        </div>
        <div className="title-main">
          <EpisodesPlaceholder />
        </div>
      </div>
    )
  const { item, season } = shown
  if (item.Type === 'Series' || item.Type === 'Movie')
    return <Title item={item} season={season} updatedAt={it.dataUpdatedAt} />
  return <Browse item={item} />
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

// Series / movie page: the left column (poster, title, meta, overview,
// the one primary button); a series adds season tabs + its episodes, a movie
// its backdrop. The primary button takes first focus (one OK press plays);
// nothing moves focus after that, on re-renders or tab changes. Data from
// before the last playback doesn't drive it: it waits for the refetch.
// oxlint-disable-next-line complexity -- render branching
function Title({
  item,
  season,
  updatedAt,
}: {
  item: Item
  season?: string
  updatedAt: number
}) {
  const { gatewayId, pc } = useContext(Tunnel)
  const navigate = useNavigate()
  const router = useRouter()
  const canGoBack = useCanGoBack()
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
  const ready = current(gatewayId, series ? es.dataUpdatedAt : updatedAt)
  const resumes =
    !!next &&
    !next.UserData?.Played &&
    (next.UserData?.PlaybackPositionTicks ?? 0) > 0
  const where =
    next && series
      ? ` S${next.ParentIndexNumber ?? '?'} · E${next.IndexNumber ?? '?'}`
      : ''
  const shown = tab ?? next?.SeasonId ?? lists?.seasons[0]?.Id
  const episodes = lists?.episodes.filter((e) => e.SeasonId === shown) ?? []
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
        <Artwork
          art={primary(item)}
          card={item}
          width={360}
          className="title-poster"
        />
        <h1>{item.Name}</h1>
        {meta.length > 0 && <p className="muted">{meta.join(' · ')}</p>}
        {item.Overview && <p className="overview">{item.Overview}</p>}
        {next && ready && (
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
        <Artwork
          art={primary(item)}
          card={item}
          width={352}
          className="still-art"
        />
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
  const q = useTunnelQuery<{ Items: Item[] }>(jf.children(item.Id))
  const items = q.data?.Items
  if (q.error && !items) return <ErrorView error={toAppError(q.error)} focus />
  if (!items)
    return (
      <ul className="tiles" role="status" aria-label="Loading">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
          <li key={n}>
            <div className="ph poster" />
            <div className="ph ph-line" />
          </li>
        ))}
      </ul>
    )
  if (!items.length) return <State icon="empty" title="Nothing here." />
  return (
    <>
      <ul className="tiles">
        {items.map((i) => (
          <li key={i.Id}>
            <button type="button" onClick={() => onOpen(i)} className="tile">
              <Artwork
                art={primary(i)}
                card={i}
                width={280}
                className="poster"
              />
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

// Guest-mode banner, on the library and the player. ponytail: checked
// once per visit, though the gateway picks the viewer per request; a viewer
// made or dropped mid-visit shows on the next one.
// No status (older gateway, error) = no banner.
function Guest() {
  const { gatewayId, pc } = useContext(Tunnel)
  const admin = useHousehold().current?.role === 'admin'
  const s = useGuestStatus(gatewayId, pc)
  const notice = guestNotice(s, admin)
  return notice && <p role="status">{notice}</p>
}

function label(i: Item) {
  if (!playable(i)) return i.Type
  const pos = i.UserData?.PlaybackPositionTicks ?? 0
  if (i.UserData?.Played) return 'Watched'
  return pos > 0 ? `Resume ${clock(pos / TICKS_PER_SECOND)}` : 'Play'
}
