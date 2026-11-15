// Library home (#203): the Resume spot (the first in-progress item; its Resume
// button takes first focus, so one OK press resumes), up to 3 more in progress,
// Recently added, and the libraries (the shell nav has no tunnel, so they live
// here). Arrow keys: GatewayLibrary's D-pad container (Library.tsx).
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AppError, toAppError } from '../../errors'
import { ErrorView } from '../../ErrorView'
import { tunnelJson } from '../../tunnel'
import { backdrop, load, primary, Tunnel, type Art } from './art'
import { clock, playable, TICKS_PER_SECOND, type Item } from './items'

type Page = { Items: Item[] }
type Lists = { resume: Item[]; recent: Item[]; views: Item[] }

const RECENT =
  '/Items?sortBy=DateCreated&sortOrder=Descending&recursive=true&includeItemTypes=Movie,Series&limit=16'

const minutes = new Intl.NumberFormat(undefined, {
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
  const [lists, setLists] = useState<Lists | null>(null)
  const [err, setErr] = useState<AppError | null>(null)
  useEffect(() => {
    const get = (url: string) => tunnelJson<Page>(pc, url).then((p) => p.Items)
    Promise.all([
      get('/UserItems/Resume?mediaTypes=Video&limit=4'),
      get(RECENT),
      get('/UserViews'),
    ]).then(
      ([resume, recent, views]) => setLists({ resume, recent, views }),
      (e) => setErr(toAppError(e)),
    )
  }, [pc])

  const open = (i: Item) =>
    navigate({
      to: playable(i)
        ? '/g/$gatewayId/play/$itemId'
        : '/g/$gatewayId/i/$itemId',
      params: { gatewayId, itemId: i.Id },
    })
  const episodes = (i: Item) =>
    navigate({
      to: '/g/$gatewayId/i/$itemId',
      params: { gatewayId, itemId: (i.SeasonId ?? i.SeriesId)! },
    })

  if (err) return <ErrorView error={err} />
  if (!lists) return <p>Loading…</p>
  const [spot, ...more] = lists.resume
  return (
    <div className="home">
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
                  autoFocus
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
      <Row title="Recently added">
        {lists.recent.map((i, n) => (
          <Pick
            key={i.Id}
            item={i}
            art={primary(i)}
            first={!spot && n === 0}
            onOpen={open}
          />
        ))}
      </Row>
      <Row title="Libraries">
        {lists.views.map((i, n) => (
          <Pick
            key={i.Id}
            item={i}
            art={primary(i)}
            wide
            first={!spot && !lists.recent.length && n === 0}
            onOpen={open}
          />
        ))}
      </Row>
    </div>
  )
}

function Row({ title, children }: { title: string; children: ReactNode[] }) {
  if (!children.length) return null
  return (
    <section className="shelf">
      <h2>{title}</h2>
      <ul>{children}</ul>
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
          width={wide ? 416 : 248}
          className={wide ? 'frame' : 'cover'}
        />
        <span>{item.Name}</span>
      </button>
    </li>
  )
}

function Watched({ item }: { item: Item }) {
  const pos = (item.UserData?.PlaybackPositionTicks ?? 0) / TICKS_PER_SECOND
  const dur = (item.RunTimeTicks ?? 0) / TICKS_PER_SECOND
  return (
    <progress
      max={Math.max(dur, 1)}
      value={pos}
      aria-label={`${item.Name} watched`}
      aria-valuetext={`${clock(pos)} of ${clock(dur)}`}
    />
  )
}

/** An image box (size from `className`); loads the image when it scrolls into view. */
export function Artwork({
  art,
  width,
  className,
}: {
  art: Art | null
  width: number
  className: string
}) {
  const { gatewayId, pc } = useContext(Tunnel)
  const box = useRef<HTMLDivElement>(null)
  const { id, type, tag } = art ?? {}
  const key = `${id}/${type}/${tag}/${width}`
  const [got, setGot] = useState<{ key: string; url: string } | null>(null)
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
            if (gone || !b) return
            url = URL.createObjectURL(b)
            setGot({ key, url })
          },
          () => {},
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
  return (
    <div ref={box} className={`art ${className}`}>
      {art && got?.key === key && <img src={got.url} alt="" />}
    </div>
  )
}
