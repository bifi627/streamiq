// The player page: the video, its controls and settings menus, and the next
// episode button. Playback itself (loads, fallbacks, resume, screen mode) is
// the Engine's (engine.ts); `remote` feeds it a phone's commands and
// `onState` gets the playback state about once a second and on every change.
import { useEffect, useRef, useState } from 'react'
import { ErrorView } from '../../ErrorView'
import { compatibleOn, quality, rawOn, setQuality } from '../../settings'
import type { Speed } from '../../speed'
import type { ScreenCommand, ScreenState } from '../gateways/api'
import { useTunnel } from './art'
import { Controls } from './Controls'
import { Privacy } from './Privacy'
import { useNext } from './queries'
import { Engine, START_VIEW, type View } from './engine'
import { qualityOptions } from './quality'
import type { Quality } from './profile'
import { TICKS_PER_SECOND, type Item } from './items'

// oxlint-disable-next-line complexity -- render branching
export function Player({
  pc,
  speed,
  itemId,
  startTicks,
  remote,
  onState,
  onExit,
  onNext,
}: {
  pc: RTCPeerConnection
  speed?: Speed
  itemId: string
  startTicks?: number // unset: Jellyfin's saved position
  /** Subscribes to commands; returns the unsubscribe. Must be stable. */
  remote?: (apply: (c: ScreenCommand) => void) => () => void
  /** Playback state for the screen. Read through a ref. */
  onState?: (s: ScreenState) => void
  onExit: (item: Item | null) => void
  /** Plays another item; unset (screen mode) = no "Next episode". */
  onNext?: (item: Item) => void
}) {
  const { gatewayId } = useTunnel()
  const video = useRef<HTMLVideoElement>(null)
  const [view, setView] = useState<View>(START_VIEW)
  const patch = (p: Partial<View>) => setView((v) => ({ ...v, ...p }))
  const { item, file, link, tracks, subs } = view
  const [q, setQ] = useState(quality)
  const [compat] = useState(compatibleOn) // as the engine reads it: once
  const engine = useRef<Engine>(null)
  const series = onNext && item?.Type === 'Episode' ? item.SeriesId : undefined
  const next = useNext(itemId, series)
  const stateRef = useRef(onState)
  useEffect(() => {
    stateRef.current = onState
  })

  useEffect(() => {
    const v = video.current
    if (!v) return
    const e = new Engine({
      pc,
      v,
      itemId,
      speed,
      set: patch,
      onState: () => stateRef.current,
    })
    engine.current = e
    return e.open(gatewayId, startTicks, remote)
  }, [pc, speed, itemId, startTicks, remote, gatewayId])

  return (
    <div>
      <Controls
        video={video}
        duration={(item?.RunTimeTicks ?? 0) / TICKS_PER_SECOND}
        blocked={view.blocked}
        settings={[
          {
            name: 'Quality',
            value: q,
            status: view.now,
            options: qualityOptions(file, q, link, rawOn(), compat),
            pick: (v) => {
              const next = v as Quality
              setQ(next)
              patch({ now: undefined }) // until the reload's decision
              setQuality(next)
              engine.current?.pickQuality(next)
            },
          },
          // Only with a choice to make: one track = no entry.
          ...(tracks.length > 1
            ? [
                {
                  name: 'Audio',
                  value: view.audio,
                  options: tracks,
                  pick: (v: string) => {
                    patch({ audio: v })
                    engine.current?.pickAudio(Number(v))
                  },
                },
              ]
            : []),
          // Only with a text subtitle: Off alone = no entry.
          ...(subs.length > 1
            ? [
                {
                  name: 'Subtitles',
                  value: view.subtitle,
                  options: subs,
                  pick: (v: string) => {
                    patch({ subtitle: v })
                    engine.current?.pickSub(Number(v))
                  },
                },
              ]
            : []),
        ]}
        onBack={() => onExit(item)}
        onNext={next && onNext && (() => onNext(next))}
        top={
          <>
            <hgroup className="now">
              <h2>{item?.SeriesName ?? item?.Name}</h2>
              {item?.SeriesName && (
                <p>
                  S{item.ParentIndexNumber ?? '?'} · E{item.IndexNumber ?? '?'}{' '}
                  {item.Name}
                </p>
              )}
            </hgroup>
            <Privacy gatewayId={gatewayId} pc={pc} />
          </>
        }
      >
        <video ref={video} />
      </Controls>
      {view.blocked && <p>Press play to start.</p>}
      {view.err && <ErrorView error={view.err} />}
    </div>
  )
}
