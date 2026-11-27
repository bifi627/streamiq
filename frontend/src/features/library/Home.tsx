// Library home: Continue watching, Recently added and the libraries (the shell
// nav has no tunnel, so they live here), each a row that scrolls sideways.
// Continue watching is the Resume spot (the first in-progress item; its Resume
// button takes first focus, so one OK press resumes) + up to 3 more, stacked
// on a phone.
// Arrow keys: GatewayLibrary's D-pad container (Library.tsx).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AppError, toAppError } from '../../shared/errors'
import { homeLists, homeView, ok, shelf, type Shelf } from './shelves'
import { ErrorView, State } from '../../shared/ErrorView'
import {
  backdrop,
  items,
  primary,
  usePlay,
  useTunnel,
  useArt,
  useTunnelQuery,
  type Art,
} from './art'
import {
  clock,
  inProgress,
  playable,
  playsAtOnce,
  TICKS_PER_SECOND,
  timeLeft,
  watchedBar,
  years,
  type Item,
} from './items'
import * as jf from './jellyfin'
const title = (i: Item) => i.SeriesName ?? i.Name
function meta(i: Item) {
  const left = timeLeft(i)
  const what =
    i.Type === 'Episode'
      ? `S${i.ParentIndexNumber ?? '?'} · E${i.IndexNumber ?? '?'} ${i.Name}`
      : (i.ProductionYear ?? i.Type)
  return [what, left].filter(Boolean).join(' · ')
}

export function Shelves() {
  const { gatewayId, pc } = useTunnel()
  const navigate = useNavigate()
  // Resume is never cached (progress changes); Recently added and the
  // libraries are cached queries.
  const [resume, setResume] = useState<Shelf | null>(null)
  useEffect(() => {
    items(pc, jf.resume).then(setResume, (e) => setResume(toAppError(e)))
  }, [pc])
  const added = shelf(useTunnelQuery(jf.recentlyAdded))
  const views = shelf(useTunnelQuery(jf.userViews))
  // First visit: all settled before the home shows, so first focus lands
  // once, in its place. A revisit with both rows cached shows at once; the Resume spot
  // joins when it answers.
  const [warm] = useState(() => !!added && !!views)
  const lists = homeLists(added, views, resume, warm)
  // Rows that answer while the user types in the search field: no focus grab.
  const free = document.activeElement === document.body

  const play = usePlay()
  const page = (i: Item) =>
    navigate({
      to: '/g/$gatewayId/i/$itemId',
      params: { gatewayId, itemId: i.Id },
    })
  const open = (i: Item) => (playable(i) ? play(i) : page(i))
  // Recently added + Library: a movie opens its page.
  const pick = (i: Item) => (playsAtOnce(i) ? play(i) : page(i))
  const episodes = (i: Item) =>
    navigate({
      to: '/g/$gatewayId/i/$itemId',
      params: { gatewayId, itemId: i.SeasonId ?? i.SeriesId ?? i.Id },
    })

  if (!lists) return <HomePlaceholder />
  const { spot, more, recent, empty } = homeView(lists)
  if (empty) return <State icon="empty" title="Nothing here." />
  return (
    <div className="home">
      <Row title="Continue watching" error={lists.resume}>
        {[]}
      </Row>
      {spot && (
        <div className="resume">
          <article className="spot">
            <Artwork art={backdrop(spot)} width={1280} className="spot-art" />
            <div className="spot-body">
              <p className="kicker">Continue watching</p>
              <h2 className="spot-title">{title(spot)}</h2>
              <p className="spot-meta">{meta(spot)}</p>
              <p className="spot-actions">
                <button
                  type="button"
                  className="primary"
                  autoFocus={!warm && free} // a revisit: focus stays where it landed
                  onClick={() => open(spot)}
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <path d="M7 4v16l13-8z" />
                  </svg>
                  Resume
                </button>
                {spot.SeriesId && (
                  <button type="button" onClick={() => episodes(spot)}>
                    Episodes
                  </button>
                )}
              </p>
            </div>
            <Watched item={spot} />
          </article>
          {more.length > 0 && (
            <ul className="more">
              {more.map((i) => (
                <li key={i.Id}>
                  <button
                    type="button"
                    className="side"
                    onClick={() => open(i)}
                  >
                    <Artwork art={backdrop(i)} width={320} className="thumb" />
                    <span>
                      <b>{title(i)}</b>
                      <small className="muted">{meta(i)}</small>
                      <Watched item={i} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Row title="Recently added" error={lists.recent}>
        {recent.map((i, n) => (
          <Pick
            key={i.Id}
            item={i}
            art={primary(i)}
            first={free && !spot && n === 0}
            onOpen={pick}
          />
        ))}
      </Row>
      <Row title="Library" error={lists.views}>
        {ok(lists.views).map((i, n) => (
          <Pick
            key={i.Id}
            item={i}
            art={primary(i)}
            wide
            first={free && !spot && !recent.length && n === 0}
            onOpen={pick}
          />
        ))}
      </Row>
    </div>
  )
}

/** The home's shape while its rows load: the spot and one row of covers. */
function HomePlaceholder() {
  return (
    <div className="home" role="status" aria-label="Loading">
      <div className="ph ph-spot" />
      <section className="shelf">
        <div className="ph ph-h2" />
        <ul>
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <li key={n} className="ph ph-cover" />
          ))}
        </ul>
      </section>
    </div>
  )
}

/** A row; with no children, only its error (Continue watching's, whose items are the spot). */
function Row({
  title,
  error,
  children,
}: {
  title: string
  error: Shelf
  children: ReactNode[]
}) {
  const failed = error instanceof AppError
  if (!failed && !children.length) return null
  return (
    <section className="shelf">
      <h2>{title}</h2>
      {failed ? <ErrorView error={error} /> : <ul>{children}</ul>}
    </section>
  )
}

function Pick({
  item,
  art,
  wide,
  first,
  onOpen,
}: {
  item: Item
  art: Art | null
  wide?: boolean
  first?: boolean
  onOpen: (i: Item) => void
}) {
  return (
    <li>
      <button
        type="button"
        className={wide ? 'pick wide' : 'pick'}
        autoFocus={first}
        onClick={() => onOpen(item)}
      >
        <Artwork
          art={art}
          card={item}
          width={wide ? 416 : 248}
          className={wide ? 'frame' : 'cover'}
        />
        <span className="card-line">{title(item)}</span>
        <YearLine item={item} />
      </button>
    </li>
  )
}

/** A grid card (folder listing, search results); `line` under the title, an
 * empty line of the same height without one. */
export function PosterTile({
  item: i,
  line,
  onOpen,
}: {
  item: Item
  line: string
  onOpen: (i: Item) => void
}) {
  return (
    <li>
      <button type="button" onClick={() => onOpen(i)} className="poster-tile">
        <span className="poster-box">
          <Artwork art={primary(i)} card={i} width={280} className="poster" />
          {(inProgress(i) || i.UserData?.Played) && <Watched item={i} />}
        </span>
        <span className="card-line">
          {i.IndexNumber != null &&
            i.Type === 'Episode' &&
            `${i.IndexNumber}. `}
          {i.Name}
        </span>
        <small className="card-line muted">{line || ' '}</small>
      </button>
    </li>
  )
}

/** A card's year line; with none, an empty line of the same height. */
export function YearLine({ item }: { item: Item }) {
  return <small className="card-line muted">{years(item) || '\u00a0'}</small>
}

export function Watched({ item }: { item: Item }) {
  const { value, max } = watchedBar(item)
  const dur = (item.RunTimeTicks ?? 0) / TICKS_PER_SECOND
  return (
    <progress
      max={max}
      value={value}
      aria-label={`${[item.SeriesName, item.Name].filter(Boolean).join(', ')} watched`}
      aria-valuetext={`${clock(value)} of ${clock(dur)}`}
    />
  )
}

/** An image box (size from `className`); loads the image when it scrolls into view.
 *  With `card`, a box with no image to show (none, or it failed) is a tint
 *  per title, without text: the card names the title. */
export function Artwork({
  art,
  card,
  width,
  className,
}: {
  art: Art | null
  card?: Item
  width: number
  className: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const key = art && `${art.id}/${art.type}/${art.tag}/${width}`
  const [seen, setSeen] = useState<string | null>(null) // the key whose box came on screen
  useEffect(() => {
    const el = box.current
    if (!key || !el) return
    const io = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return
        io.disconnect()
        setSeen(key)
      },
      { rootMargin: '100px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [key])
  const q = useArt(art, width, seen !== null && seen === key)
  const url = q.data
  const failed = q.isError || q.data === null
  if (card && (!art || failed))
    return (
      <div
        ref={box}
        className={`art ${className} title-card tint-${tint(card.Name)}`}
      />
    )
  return (
    <div ref={box} className={`art ${className}`}>
      {art && url && <img src={url} alt="" />}
    </div>
  )
}

/** A muted colour per title (one of 12 .tint-N classes in index.css): the
 * same name always gets the same one. */
function tint(name: string) {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360
  // * 137: names one letter apart land far apart, not on the next hue.
  return ((h * 137) % 360) % 12
}
