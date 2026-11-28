// The Photos tab: the gateway's photo libraries after a Favorites tile
// (PhotosHome), a folder's grid (PhotoFolder: sub-folders, then photos,
// square tiles; folder id `favorites`: the favorite photos) and the
// full-screen viewer over it (?view=<photo id>, so Back closes it).
// Routes (App.tsx): /g/$gatewayId/photos[/$folderId], in the gateway's tunnel.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { PageBar } from '../../shared/PageBar'
import { useBack } from '../../shared/slots'
import { ErrorView, State } from '../../shared/ErrorView'
import { toAppError } from '../../shared/errors'
import {
  primary,
  type Art,
  useArt,
  useFolderPages,
  useTunnel,
  useTunnelQuery,
} from '../library/art'
import { Artwork } from '../library/Home'
import { Favorite } from '../library/Favorite'
import { folderUp, type Item } from '../library/items'
import { folderView } from '../library/paging'
import * as jf from '../library/jellyfin'
import {
  caption,
  isPhoto,
  photoLibraries,
  screenSize,
  step,
  swipe,
  viewerKey,
} from './gallery'

type Views = { Items: Item[] }

const FAVORITES = 'favorites' // not a Jellyfin id (32 hex)
const favoritesTile = { Id: FAVORITES, Name: 'Favorites' } as Item

export function PhotosHome() {
  const q = useTunnelQuery<Views>(jf.userViews)
  const open = useOpenFolder()
  const newest = useFolderPages(FAVORITES, jf.favoritePhotos).data?.pages[0]
    ?.Items[0]
  if (q.error && !q.data) return <ErrorView error={toAppError(q.error)} focus />
  const libs = q.data && photoLibraries(q.data.Items)
  return (
    <>
      <PageBar title="Photos" />
      {!libs && <GridPlaceholder />}
      {libs && !libs.length && (
        <State
          icon="empty"
          title="No photo libraries on this gateway."
          text="Add a “Home videos and photos” library in Jellyfin."
        />
      )}
      {libs && !!libs.length && (
        <ul className="photo-grid">
          {newest && (
            <FolderTile
              item={favoritesTile}
              cover={primary(newest)}
              onOpen={open}
            />
          )}
          {libs.map((l) => (
            <FolderTile key={l.Id} item={l} onOpen={open} />
          ))}
        </ul>
      )}
    </>
  )
}

function useOpenFolder() {
  const { gatewayId } = useTunnel()
  const navigate = useNavigate()
  return (i: Item) =>
    navigate({
      to: '/g/$gatewayId/photos/$folderId',
      params: { gatewayId, folderId: i.Id },
    })
}

// A library or album: its sub-folders, then its photos; a photo opens the viewer.
export function PhotoFolder({
  folderId,
  view,
}: {
  folderId: string
  view?: string
}) {
  const { gatewayId } = useTunnel()
  const navigate = useNavigate()
  const favorites = folderId === FAVORITES
  const it = useTunnelQuery<Item>(favorites ? null : jf.item(folderId))
  useTunnelQuery<Views>(jf.userViews) // a deep link here: the nav's Photos tab (tab.ts)
  const q = useFolderPages(
    folderId,
    favorites ? jf.favoritePhotos : jf.photoChildren,
  )
  const listed = folderView({
    pages: q.data?.pages,
    hasNext: q.hasNextPage,
    nextFailed: q.isFetchNextPageError,
    fetching: q.isFetchingNextPage,
  })
  const photos = listed?.items.filter(isPhoto) ?? []
  const viewer = useViewer(view, photos, q)
  const up = it.data && folderUp(it.data)
  const back = useBack(() =>
    navigate(
      up
        ? {
            to: '/g/$gatewayId/photos/$folderId',
            params: { gatewayId, folderId: up },
          }
        : { to: '/g/$gatewayId/photos', params: { gatewayId } },
    ),
  )
  return (
    <>
      <PageBar
        title={favorites ? favoritesTile.Name : it.data?.Name}
        onBack={back}
      />
      <Pages
        listed={listed}
        error={q.error ?? it.error}
        more={() => void q.fetchNextPage({ cancelRefetch: false })}
        onPhoto={viewer.open}
      />
      {view && (
        <Viewer
          key={view}
          id={view}
          listed={photos.find((p) => p.Id === view)}
          onMove={viewer.move}
          onClose={viewer.close}
        />
      )}
    </>
  )
}

/** The viewer's URL state: opening it is a history entry (Back closes it),
 * previous / next replace it. Closed, focus returns to the photo last shown. */
function useViewer(
  view: string | undefined,
  photos: Item[],
  q: ReturnType<typeof useFolderPages>,
) {
  const navigate = useNavigate()
  const router = useRouter()
  const opened = useRef(false)
  const show = (id: string, replace: boolean) =>
    void navigate({ to: '.', search: { view: id }, replace })
  const [last, setLast] = useState(view)
  if (view && view !== last) setLast(view)
  useEffect(() => {
    if (!view && last)
      document.querySelector<HTMLElement>(`[data-photo="${last}"]`)?.focus()
  }, [view, last])
  return {
    open: (id: string) => {
      opened.current = true
      show(id, false)
    },
    close: () =>
      opened.current
        ? router.history.back()
        : void navigate({ to: '.', search: {}, replace: true }), // a deep link
    move: (dir: -1 | 1) => {
      if (!view) return
      const s = step(photos, view, dir, q.hasNextPage)
      if (s === 'more')
        void q.fetchNextPage({ cancelRefetch: false }).then((r) => {
          const all = (r.data?.pages ?? []).flatMap((p) => p.Items)
          const t = step(all.filter(isPhoto), view, dir, false)
          if (t && t !== 'more') show(t.to, true)
        })
      else if (s) show(s.to, true)
    },
  }
}

/** The folder's loaded pages as one grid, then what follows them (paging.ts). */
function Pages({
  listed,
  error,
  more,
  onPhoto,
}: {
  listed: ReturnType<typeof folderView>
  error: unknown
  more: () => void
  onPhoto: (id: string) => void
}) {
  const openFolder = useOpenFolder()
  if (!listed)
    return error ? (
      <ErrorView error={toAppError(error)} focus />
    ) : (
      <GridPlaceholder />
    )
  const { items, tail } = listed
  if (!items.length) return <State icon="empty" title="No photos here." />
  return (
    <>
      <ul className="photo-grid">
        {items.map((i) =>
          isPhoto(i) ? (
            <PhotoTile key={i.Id} item={i} onOpen={() => onPhoto(i.Id)} />
          ) : (
            <FolderTile key={i.Id} item={i} onOpen={openFolder} />
          ),
        )}
      </ul>
      {tail === 'retry' && <ErrorView error={error} onRetry={more} />}
      {tail === 'more' && <OnScreen key={items.length} onShow={more} />}
    </>
  )
}

function PhotoTile({ item, onOpen }: { item: Item; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        className="photo-tile"
        data-photo={item.Id}
        aria-label={caption(item)}
        onClick={onOpen}
      >
        <span className="photo-box">
          <Artwork
            art={primary(item)}
            width={720}
            height={720}
            className="photo-art"
          />
        </span>
      </button>
    </li>
  )
}

/** A library or album: `cover`, else its own image, else its first photo
 * (Jellyfin makes none for photo folders), else a folder icon.
 * ponytail: one Jellyfin request per folder tile, on render, not on screen. */
function FolderTile({
  item,
  cover: given,
  onOpen,
}: {
  item: Item
  cover?: Art | null
  onOpen: (i: Item) => void
}) {
  const own = given ?? primary(item)
  const first = useTunnelQuery<Views>(
    own || given === null ? null : jf.firstPhoto(item.Id),
  ).data?.Items[0]
  const cover = own ?? (first && primary(first))
  return (
    <li>
      <button
        type="button"
        className="photo-tile folder"
        onClick={() => onOpen(item)}
      >
        <span className="photo-box">
          {cover ? (
            <Artwork
              art={cover}
              width={480}
              height={480}
              className="photo-art"
            />
          ) : (
            <svg
              className="photo-art"
              aria-hidden="true"
              viewBox="0 0 24 24"
              data-testid="folder-icon"
            >
              <path d="M3 6h7l2 2h9v11H3z" />
            </svg>
          )}
          <span className="photo-name">{item.Name}</span>
        </span>
      </button>
    </li>
  )
}

function GridPlaceholder() {
  return (
    <ul className="photo-grid" role="status" aria-label="Loading">
      {[0, 1, 2, 3, 4, 5].map((n) => (
        <li key={n}>
          <span className="photo-box ph" />
        </li>
      ))}
    </ul>
  )
}

/** Calls onShow once it is near the viewport (Library.tsx's twin). */
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

// Full screen over the page: the photo at the screen's size, its name;
// ←/→ (D-pad), a swipe or the side buttons step, Escape or Back closes.
// Arrow keys stay here: the grid behind it never takes focus.
function Viewer({
  id,
  listed,
  onMove,
  onClose,
}: {
  id: string
  listed?: Item
  onMove: (dir: -1 | 1) => void
  onClose: () => void
}) {
  // Its own item: the heart's saved state, which the loaded pages miss once
  // it changes; also a deep link to a photo not on them.
  const fetched = useTunnelQuery<Item>(jf.item(id)).data
  const item = fetched ?? listed
  const [size] = useState(() =>
    screenSize(innerWidth, innerHeight, devicePixelRatio),
  )
  const art = useArt(
    item ? primary(item) : null,
    size.width,
    !!item,
    size.height,
  )
  const box = useRef<HTMLDivElement>(null)
  const touch = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => box.current?.focus(), [])
  const failed = art.isError || art.data === null
  const name = item ? caption(item) : ''
  return createPortal(
    <div
      ref={box}
      className="viewer"
      role="dialog"
      aria-modal="true"
      aria-label={name || 'Photo'}
      tabIndex={-1}
      // A click (the heart's too) leaves focus here: the heart remounts once
      // its saved value comes back (Favorite.tsx) and would drop it to <body>.
      onClick={() => box.current?.focus()}
      onKeyDown={(e) => {
        const k = viewerKey(e.key)
        if (!k) return
        e.preventDefault()
        e.stopPropagation() // not the page's D-pad
        if (k === 'close') onClose()
        else if (k !== 'stay') onMove(k)
      }}
      onTouchStart={(e) => {
        const t = e.touches[0]
        touch.current = { x: t.clientX, y: t.clientY }
      }}
      onTouchEnd={(e) => {
        const t = e.changedTouches[0]
        const from = touch.current
        touch.current = null
        const dir = from && swipe(t.clientX - from.x, t.clientY - from.y)
        if (dir) onMove(dir)
      }}
    >
      {art.data && <img src={art.data} alt={name} />}
      {failed && <p className="viewer-msg">This photo couldn’t be loaded.</p>}
      {!art.data && !failed && (
        <p className="viewer-msg" role="status">
          Loading…
        </p>
      )}
      <p className="viewer-caption">{name}</p>
      {item && <Favorite item={item} />}
      <button
        type="button"
        className="viewer-btn viewer-prev"
        aria-label="Previous photo"
        tabIndex={-1}
        onClick={() => onMove(-1)}
      >
        ‹
      </button>
      <button
        type="button"
        className="viewer-btn viewer-next"
        aria-label="Next photo"
        tabIndex={-1}
        onClick={() => onMove(1)}
      >
        ›
      </button>
      <button
        type="button"
        className="viewer-btn viewer-close"
        aria-label="Close"
        onClick={onClose}
      >
        ×
      </button>
    </div>,
    document.body,
  )
}
