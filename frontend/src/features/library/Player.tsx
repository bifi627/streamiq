// HLS playback through the tunnel. Jellyfin decides remux vs transcode
// (videoCodec=h264&audioCodec=aac); hls.js plays it via the tunnel loader.
// Resume: start at Jellyfin's saved position; report it every 10 s, on pause
// and on exit. (/Sessions/Playing* is ignored for API-key callers, so the
// position goes straight to the user's UserData.)
import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { tunnelJson } from '../../tunnel'
import { changed, diag, event, ranges, watchVideo } from '../../diag'
import { tunnelLoader, TUNNEL_ORIGIN } from './loader'
import { clock, TICKS_PER_SECOND, type Item } from './items'

type PlaybackInfo = {
  PlaySessionId: string
  MediaSources: {
    Id: string
    MediaStreams: {
      Index: number
      Type: string
      IsTextSubtitleStream?: boolean
    }[]
  }[]
}

export function Player({
  pc,
  item,
  onExit,
}: {
  pc: RTCPeerConnection
  item: Item
  onExit: () => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const hls = useRef<Hls | null>(null)
  const [subs, setSubs] = useState<{ id: number; name: string }[]>([])
  const [sub, setSub] = useState(-1)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const v = video.current!
    let h: Hls | null = null
    let gone = false
    let lastSaved = -1
    const save = (body: object) =>
      tunnelJson(pc, `/UserItems/${item.Id}/UserData`, body).catch(() => {})
    const report = () => {
      const t = Math.floor(v.currentTime)
      if (h && t > 0 && t !== lastSaved) {
        lastSaved = t
        save({ PlaybackPositionTicks: t * TICKS_PER_SECOND })
      }
    }

    ;(async () => {
      if (!Hls.isSupported())
        throw new Error(
          'this browser has no MSE (iOS Safari is not supported yet)',
        )
      // Fresh UserData: the listing may be stale (resume position).
      const [fresh, info] = await Promise.all([
        tunnelJson<Item>(pc, `/Items/${item.Id}`),
        tunnelJson<PlaybackInfo>(pc, `/Items/${item.Id}/PlaybackInfo`, {}),
      ])
      if (gone) return
      const src = info.MediaSources[0]
      const text = src.MediaStreams.find(
        (s) => s.Type === 'Subtitle' && s.IsTextSubtitleStream,
      )
      const q = new URLSearchParams({
        mediaSourceId: src.Id,
        PlaySessionId: info.PlaySessionId,
        videoCodec: 'h264',
        audioCodec: 'aac',
        ...(text && {
          SubtitleStreamIndex: String(text.Index),
          SubtitleMethod: 'Hls',
        }),
      })
      h = new Hls({
        loader: tunnelLoader(pc),
        startPosition:
          (fresh.UserData?.PlaybackPositionTicks ?? 0) / TICKS_PER_SECOND,
        renderTextTracksNatively: true,
      })
      h.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_e, d) =>
        setSubs(
          d.subtitleTracks.map((t) => ({
            id: t.id,
            name: t.name || t.lang || `track ${t.id}`,
          })),
        ),
      )
      h.on(Hls.Events.ERROR, (_e, d) => {
        event(
          `hls ${d.fatal ? 'FATAL' : 'error'}: ${d.details}${d.error ? ` (${d.error.message})` : ''}`,
        )
        if (d.fatal) setErr(`playback error: ${d.details}`)
      })
      // Diagnostics: what the TV is asked to decode, and whether it says it can.
      h.on(Hls.Events.BUFFER_CODECS, (_e, d) =>
        Object.entries(d).forEach(([k, t]) => {
          const type = t?.codec && `${t.container};codecs="${t.codec}"`
          if (type)
            event(
              `hls ${k}: ${type} supported=${MediaSource.isTypeSupported(type)}`,
            )
        }),
      )
      // Diagnostics: are segments parsed and appended, and where do audio and
      // video land? video.buffered is only their overlap.
      let parsed = 0
      let appended = 0
      let r: Partial<Record<string, TimeRanges>> = {}
      const sb = () => {
        diag.sb = [
          `frags parsed ${parsed}`,
          `appends ${appended}`,
          ...Object.entries(r).map(([k, t]) => t && `${k} ${ranges(t)}`),
        ]
          .filter(Boolean)
          .join(' · ')
        changed()
      }
      h.on(Hls.Events.FRAG_PARSED, () => {
        parsed++
        sb()
      })
      h.on(Hls.Events.BUFFER_APPENDED, (_e, d) => {
        appended++
        r = d.timeRanges
        sb()
      })
      h.attachMedia(v)
      h.loadSource(`${TUNNEL_ORIGIN}/Videos/${item.Id}/master.m3u8?${q}`)
      h.subtitleTrack = -1
      hls.current = h
      v.play().catch(() => {}) // autoplay may need a click; controls are there
    })().catch((e: Error) => setErr(e.message))

    const unwatch = watchVideo(v)
    const tick = setInterval(report, 10_000)
    const ended = () => save({ Played: true, PlaybackPositionTicks: 0 })
    v.addEventListener('pause', report)
    v.addEventListener('seeked', report)
    v.addEventListener('ended', ended)
    window.addEventListener('pagehide', report)
    return () => {
      gone = true
      unwatch()
      clearInterval(tick)
      report()
      v.removeEventListener('pause', report)
      v.removeEventListener('seeked', report)
      v.removeEventListener('ended', ended)
      window.removeEventListener('pagehide', report)
      h?.destroy()
    }
  }, [pc, item.Id])

  return (
    <div>
      <h3>{item.Name}</h3>
      <video
        ref={video}
        controls
        style={{ width: '100%', background: 'black' }}
      />
      <p>
        <button type="button" onClick={onExit}>
          Back
        </button>{' '}
        {subs.length > 0 && (
          <label>
            Subtitles{' '}
            <select
              value={sub}
              onChange={(e) => {
                const id = Number(e.target.value)
                setSub(id)
                if (hls.current) {
                  hls.current.subtitleTrack = id
                  hls.current.subtitleDisplay = id >= 0
                }
              }}
            >
              <option value={-1}>Off</option>
              {subs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}{' '}
        {item.RunTimeTicks && (
          <small>{clock(item.RunTimeTicks / TICKS_PER_SECOND)}</small>
        )}
      </p>
      {err && <p style={{ color: 'crimson' }}>{err}</p>}
    </div>
  )
}
