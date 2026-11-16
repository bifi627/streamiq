// Library home (#203): the Resume spot (the first in-progress item; its Resume
// button takes first focus, so one OK press resumes), up to 3 more in progress,
// Recently added, and the libraries (the shell nav has no tunnel, so they live
// here). Arrow keys: GatewayLibrary's D-pad container (Library.tsx).
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AppError, toAppError } from '../../errors'
import { ErrorView, State } from '../../ErrorView'
import {
  backdrop,
  items,
  load,
  primary,
  Tunnel,
  useTunnelQuery,
  type Art,
} from './art'
import {
  clock,
  playable,
  playsAtOnce,
  TICKS_PER_SECOND,
  type Item,
} from './items'

// Each row loads on its own (#317): one that fails shows its error, the others stay.
type Shelf = Item[] | AppError
type Lists = { resume: Shelf; recent: Shelf; views: Shelf }

const RECENT =
  '/Items?sortBy=DateCreated&sortOrder=Descending&recursive=true&includeItemTypes=Movie,Series&limit=16'

export const minutes = new Intl.NumberFormat(undefined, {
  style: 'unit',
  unit: 'minute',
  unitDisplay: 'short',
})
const title = (i: Item) => i.SeriesName ?? i.Name
function meta(i: Item) {
  const pos = i.UserData?.PlaybackPositionTicks ?? 0
  const left = i.RunTimeTicks
    ? `${minutes.format(Math.max(1, Math.round((i.RunTimeTicks - pos) / TICKS_PER_SECOND / 60)))} left`
    : ''
  const what =
    i.Type === 'Episode'
      ? `S${i.ParentIndexNumber ?? '?'} · E${i.IndexNumber ?? '?'} ${i.Name}`
      : (i.ProductionYear ?? i.Type)
  return [what, left].filter(Boolean).join(' · ')
}

export function Home() {
  const { gatewayId, pc } = useContext(Tunnel)
  const navigate = useNavigate()
  // Resume is never cached (progress changes); Recently added and the
  // libraries are cached queries (#360).
  const [resume, setResume] = useState<Shelf | null>(null)
  useEffect(() => {
    items(pc, '/UserItems/Resume?mediaTypes=Video&limit=4').then(
      setResume,
      (e) => setResume(toAppError(e)),
    )
  }, [pc])
  const shelf = (q: ReturnType<typeof useTunnelQuery<{ Items: Item[] }>>) =>
    q.data ? q.data.Items : q.error ? toAppError(q.error) : undefined
  const added = shelf(useTunnelQuery(RECENT))
  const views = shelf(useTunnelQuery('/UserViews'))
  // First visit: all settled before the home shows, so first focus lands as
  // before (#203). A revisit with both rows cached shows at once (#360); the
  // Resume spot joins when it answers.
  const [warm] = useState(() => !!added && !!views)
  const lists: Lists | null =
    added && views && (resume || warm)
      ? { resume: resume ?? [], recent: added, views }
      : null

  const open = (i: Item) =>
    navigate({
      to: playable(i)
        ? '/g/$gatewayId/play/$itemId'
        : '/g/$gatewayId/i/$itemId',
      params: { gatewayId, itemId: i.Id },
    })
  // Recently added + Libraries: a movie opens its page (#204).
  const pick = (i: Item) =>
    navigate({
      to: playsAtOnce(i)
        ? '/g/$gatewayId/play/$itemId'
        : '/g/$gatewayId/i/$itemId',
      params: { gatewayId, itemId: i.Id },
    })
  const episodes = (i: Item) =>
    navigate({
      to: '/g/$gatewayId/i/$itemId',
      params: { gatewayId, itemId: (i.SeasonId ?? i.SeriesId)! },
    })

  if (!lists) return <HomePlaceholder />
  const ok = (r: Shelf) => (r instanceof AppError ? [] : r)
  const [spot, ...more] = ok(lists.resume)
  const recent = ok(lists.recent)
  if (!spot && !recent.length && !ok(lists.views).length && !failed(lists))
    return <State icon="empty" title="Nothing here." />
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
                  autoFocus={!warm} // a revisit: focus stays where it landed
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
            first={!spot && n === 0}
            onOpen={pick}
          />
        ))}
      </Row>
      <Row title="Libraries" error={lists.views}>
        {ok(lists.views).map((i, n) => (
          <Pick
            key={i.Id}
            item={i}
            art={primary(i)}
            wide
            first={!spot && !recent.length && n === 0}
            onOpen={pick}
          />
        ))}
      </Row>
    </div>
  )
}

const failed = (l: Lists) => Object.values(l).some((r) => r instanceof AppError)

/** The home's shape while its rows load (#206): the spot and one row of covers. */
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
  first: boolean
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
        <span>{item.Name}</span>
      </button>
    </li>
  )
}

export function Watched({ item }: { item: Item }) {
  const pos = (item.UserData?.PlaybackPositionTicks ?? 0) / TICKS_PER_SECOND
  const dur = (item.RunTimeTicks ?? 0) / TICKS_PER_SECOND
  return (
    <progress
      max={Math.max(dur, 1)}
      value={pos}
      aria-label={`${[item.SeriesName, item.Name].filter(Boolean).join(', ')} watched`}
      aria-valuetext={`${clock(pos)} of ${clock(dur)}`}
    />
  )
}

/** An image box (size from `className`); loads the image when it scrolls into view.
 *  With `card`, a box with no image to show (none, or it failed) is a title card (#323). */
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
  const { gatewayId, pc } = useContext(Tunnel)
  const box = useRef<HTMLDivElement>(null)
  const { id, type, tag } = art ?? {}
  const key = `${id}/${type}/${tag}/${width}`
  const [got, setGot] = useState<{ key: string; url: string } | null>(null)
  const [failed, setFailed] = useState('')
  useEffect(() => {
    const el = box.current
    if (!id || !type || !tag || !el) return
    let url = ''
    let gone = false
    const seen = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return
        seen.disconnect()
        load(pc, gatewayId, { id, type, tag }, width).then(
          (b) => {
            if (gone) return
            if (!b) return setFailed(key)
            url = URL.createObjectURL(b)
            setGot({ key, url })
          },
          () => !gone && setFailed(key),
        )
      },
      { rootMargin: '100px' },
    )
    seen.observe(el)
    return () => {
      gone = true
      seen.disconnect()
      if (url) URL.revokeObjectURL(url)
    }
  }, [pc, gatewayId, id, type, tag, width, key])
  if (card && (!art || failed === key))
    return (
      <div
        ref={box}
        className={`art ${className} title-card tint-${tint(card.Name)}`}
      >
        <span aria-hidden="true">
          {card.Name}
          {card.ProductionYear && ` (${card.ProductionYear})`}
        </span>
      </div>
    )
  return (
    <div ref={box} className={`art ${className}`}>
      {art && got?.key === key && <img src={got.url} alt="" />}
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
