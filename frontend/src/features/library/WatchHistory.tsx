// Watch history: the current gateway's views of this user, newest first
// (views.ts). Never cached: a playback adds a line.
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { PageBar } from '../../shared/PageBar'
import { useBack } from '../../shared/slots'
import { State } from '../../shared/ErrorView'
import { AppError, toAppError } from '../../shared/errors'
import { tunnelJson } from '../../shared/tunnel'
import { PosterTile } from './Home'
import { usePick, useTunnel } from './art'
import type { Item } from './items'
import * as jf from './jellyfin'
import {
  entries,
  idChunks,
  VIEWS,
  viewLine,
  viewsMessage,
  type Entry,
  type View,
} from './views'

async function load(pc: RTCPeerConnection) {
  const views = await tunnelJson<View[]>(pc, VIEWS)
  const pages = await Promise.all(
    idChunks(views).map((ids) =>
      tunnelJson<{ Items: Item[] }>(pc, jf.byIds(ids)),
    ),
  )
  return entries(
    views,
    pages.flatMap((p) => p.Items),
  )
}

export function WatchHistory() {
  const { gatewayId, pc } = useTunnel()
  const navigate = useNavigate()
  const back = useBack(() =>
    navigate({ to: '/g/$gatewayId', params: { gatewayId } }),
  )
  const [list, setList] = useState<Entry[] | AppError | null>(null)
  useEffect(() => {
    load(pc).then(setList, (e) => setList(toAppError(e)))
  }, [pc])
  return (
    <>
      <PageBar title="Watch history" onBack={back} />
      <Entries list={list} />
    </>
  )
}

function Entries({ list }: { list: Entry[] | AppError | null }) {
  const open = usePick()
  const box = useRef<HTMLUListElement>(null)
  // The D-pad starts on the newest entry (also on Back from one).
  useEffect(() => {
    if (document.activeElement === document.body)
      box.current?.querySelector('button')?.focus()
  }, [list])
  if (list instanceof AppError) return <p role="alert">{viewsMessage(list)}</p>
  if (!list)
    return <div className="ph poster" role="status" aria-label="Loading" />
  if (!list.length)
    return <State icon="empty" title="Nothing watched here yet." />
  return (
    <ul ref={box} className="poster-grid" aria-label="Watch history">
      {list.map(({ view, item }, n) => (
        <PosterTile
          key={n}
          item={item}
          line={viewLine(item, view.at)}
          onOpen={open}
        />
      ))}
    </ul>
  )
}
