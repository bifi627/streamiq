// HLS playback through the tunnel. Jellyfin decides remux vs transcode from a
// DeviceProfile built from a capability probe (profile.ts, #115); hls.js plays
// the TranscodingUrl it returns via the tunnel loader.
// Resume: start at Jellyfin's saved position; report it every 10 s, on pause
// and on exit, straight to the viewer's UserData (/Sessions/Playing* is not
// on the gateway allowlist).
// Fallback (#81): some devices (webOS TV, Chrome 87) drop stream-copied video
// after a seek/resume. When video appends stop covering the playhead, reload
// there with a video transcode for the rest of this playback.
// Audio fallback (#115): on an audio decode/append error, reload there with
// stereo AAC (no audio copy) for the rest of this playback.
import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { tunnelJson } from '../../tunnel'
import { changed, diag, event, ranges, watchVideo } from '../../diag'
import { compatibleOn } from '../../settings'
import { tunnelLoader, TUNNEL_ORIGIN } from './loader'
import { Controls } from './Controls'
import { decision, describe, deviceProfile, probe, type Probe } from './profile'
import { covers, STUCK_APPENDS, TICKS_PER_SECOND, type Item } from './items'

// Video transcode output ceilings, set on the TranscodingUrl only when Jellyfin
// transcodes video. Jellyfin only scales down and clamps the bitrate to the
// source's, so smaller sources keep their size. Never with stream copy: a
// bitrate there makes Jellyfin transcode anything above it.
// ponytail: fixed 1080p/8 Mbps; a quality picker (per device/uplink) replaces this.
const TRANSCODE = {
  VideoBitrate: '8000000',
  MaxHeight: '1080',
  MaxWidth: '1920',
}

type PlaybackInfo = {
  ErrorCode?: string
  MediaSources: {
    TranscodingUrl?: string
    MediaStreams: NonNullable<Item['MediaStreams']>
  }[]
}

/** What the current load may stream-copy; the fallbacks turn these off. */
type Copy = { video: boolean; audio: boolean }

export function Player({
  pc,
  itemId,
  onExit,
}: {
  pc: RTCPeerConnection
  itemId: string
  onExit: (item: Item | null) => void
}) {
  const [item, setItem] = useState<Item | null>(null)
  const [blocked, setBlocked] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const v = video.current!
    let h: Hls | null = null
    let gone = false
    let lastSaved = -1
    const save = (body: object) =>
      tunnelJson(pc, `/UserItems/${itemId}/UserData`, body).catch(() => {})
    const report = () => {
      const t = Math.floor(v.currentTime)
      if (h && t > 0 && t !== lastSaved) {
        lastSaved = t
        save({ PlaybackPositionTicks: t * TICKS_PER_SECOND })
      }
    }

    let caps: Probe
    const compatible = compatibleOn() // read once: applies from the next playback
    // First text subtitle: offered via HLS, off (no picker yet: #136).
    let text: number | undefined
    // Loads the stream at `at` seconds; called again by the fallbacks.
    const start = async (copy: Copy, at: number) => {
      // A new PlaySessionId each time, so Jellyfin starts a new job for new params.
      const info = await tunnelJson<PlaybackInfo>(
        pc,
        `/Items/${itemId}/PlaybackInfo`,
        {
          DeviceProfile: deviceProfile(caps, !copy.audio, compatible),
          EnableDirectPlay: false,
          EnableDirectStream: false,
          AllowVideoStreamCopy: copy.video,
          AllowAudioStreamCopy: copy.audio,
          ...(!copy.audio && { MaxAudioChannels: 2 }),
          ...(text !== undefined && { SubtitleStreamIndex: text }),
        },
      )
      if (gone) return
      const src = info.MediaSources[0]
      if (!src?.TranscodingUrl)
        throw new Error(
          `Jellyfin offers no stream (${info.ErrorCode ?? 'no TranscodingUrl'})`,
        )
      const d = decision(src.TranscodingUrl, src.MediaStreams)
      event(`jellyfin: ${d.text}`)
      const [path, query] = src.TranscodingUrl.split('?')
      const q = new URLSearchParams(query)
      if (!d.videoCopy)
        Object.entries(TRANSCODE).forEach(([k, val]) => q.set(k, val))
      h = new Hls({
        loader: tunnelLoader(pc),
        startPosition: at,
        renderTextTracksNatively: true,
        // hls.js grows the forward buffer up to 600 s for low bitrates; a TV's
        // MSE quota fills long before that (bufferFullError on webOS).
        maxMaxBufferLength: 60,
      })
      h.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_e, d) =>
        event(
          `hls subtitles: ${d.subtitleTracks.map((t) => t.name || t.lang || t.id).join(', ') || 'none'}`,
        ),
      )
      h.on(Hls.Events.ERROR, (_e, e) => {
        event(
          `hls ${e.fatal ? 'FATAL' : 'error'}: ${e.details}${e.error ? ` (${e.error.message})` : ''}`,
        )
        // Audio fallback: the device can't take the audio Jellyfin sent
        // (e.g. 5.1 AAC on old webOS). Once per playback.
        const audio =
          e.sourceBufferName === 'audio' ||
          /audio/i.test(
            `${e.mimeType ?? ''} ${e.error?.message ?? ''} ${v.error?.message ?? ''}`,
          )
        if (copy.audio && audio && e.type === Hls.ErrorTypes.MEDIA_ERROR)
          return reload({ ...copy, audio: false }, 'stereo AAC')
        if (e.fatal) setErr(`playback error: ${e.details}`)
      })
      // What the device is asked to decode, and whether it says it can.
      h.on(Hls.Events.BUFFER_CODECS, (_e, d) =>
        Object.entries(d).forEach(([k, t]) => {
          const type = t?.codec && `${t.container};codecs="${t.codec}"`
          const m = t?.metadata
          if (type)
            event(
              `hls ${k}: ${type} supported=${MediaSource.isTypeSupported(type)}${m?.channelCount ? ` ${m.channelCount}ch` : ''}${m?.width ? ` ${m.width}x${m.height}` : ''}`,
            )
        }),
      )
      // Are segments parsed and appended, and where do audio and video land?
      // video.buffered is only their overlap; an empty video range here is the
      // stuck state the fallback below detects.
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
      let stuck = 0 // video appends in a row that left the playhead empty
      h.on(Hls.Events.BUFFER_APPENDED, (_e, a) => {
        appended++
        r = a.timeRanges
        sb()
        // fMP4 (HEVC/AV1-capable devices) muxes into one 'audiovideo' buffer.
        if (!d.videoCopy || (a.type !== 'video' && a.type !== 'audiovideo'))
          return
        if (covers(a.timeRanges[a.type], v.currentTime)) stuck = 0
        else if (++stuck >= STUCK_APPENDS)
          reload({ ...copy, video: false }, 'video transcode')
      })
      h.attachMedia(v)
      h.loadSource(`${TUNNEL_ORIGIN}${path}?${q}`)
      h.subtitleTrack = -1
      // Autoplay is blocked without a user gesture (deep link / reload): the
      // control bar stays up with Play focused, one Enter/tap starts it.
      v.play().catch((e: Error) => {
        event(`autoplay blocked: ${e.name}`)
        setBlocked(true)
      })
    }

    // Restarts at the playhead with less stream copy (the fallbacks).
    const reload = (copy: Copy, why: string) => {
      const t = v.currentTime
      event(`fallback: ${why} @${t.toFixed(1)}`)
      const old = h
      h = null // no position reports while the media detaches
      old?.destroy()
      start(copy, t).catch((e: Error) => setErr(e.message))
    }

    ;(async () => {
      if (!Hls.isSupported())
        throw new Error(
          'this browser has no MSE (iOS Safari is not supported yet)',
        )
      if (compatible) event('compatible mode: on')
      caps = await probe()
      event(`probe: ${describe(caps)}`)
      deviceProfile(caps, false, compatible) // throws without H.264, before anything loads
      // Fresh UserData: the listing may be stale (resume position).
      const fresh = await tunnelJson<Item>(pc, `/Items/${itemId}`)
      if (gone) return
      setItem(fresh)
      text = fresh.MediaStreams?.find(
        (s) => s.Type === 'Subtitle' && s.IsTextSubtitleStream,
      )?.Index
      await start(
        { video: true, audio: true },
        (fresh.UserData?.PlaybackPositionTicks ?? 0) / TICKS_PER_SECOND,
      )
    })().catch((e: Error) => setErr(e.message))

    const unwatch = watchVideo(v)
    const tick = setInterval(report, 10_000)
    const ended = () => save({ Played: true, PlaybackPositionTicks: 0 })
    const playing = () => setBlocked(false)
    v.addEventListener('play', playing)
    v.addEventListener('pause', report)
    v.addEventListener('seeked', report)
    v.addEventListener('ended', ended)
    window.addEventListener('pagehide', report)
    return () => {
      gone = true
      unwatch()
      clearInterval(tick)
      report()
      v.removeEventListener('play', playing)
      v.removeEventListener('pause', report)
      v.removeEventListener('seeked', report)
      v.removeEventListener('ended', ended)
      window.removeEventListener('pagehide', report)
      h?.destroy()
    }
  }, [pc, itemId])

  return (
    <div>
      <h3>{item?.Name}</h3>
      <Controls
        video={video}
        duration={(item?.RunTimeTicks ?? 0) / TICKS_PER_SECOND}
        blocked={blocked}
        onBack={() => onExit(item)}
      >
        <video ref={video} />
      </Controls>
      {blocked && <p>Press play to start.</p>}
      {err && <p style={{ color: 'crimson' }}>{err}</p>}
    </div>
  )
}
