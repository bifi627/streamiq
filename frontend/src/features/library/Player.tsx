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
// Quality (#108): the picker's limit goes into the profile; a switch reloads at
// the playhead the same way (Jellyfin serves one HLS level per load). The
// picker (#161) offers only rungs that scale this source down, and says what
// plays (original or transcode size).
// Audio (#109): the same reload with AudioStreamIndex (no switchable audio
// renditions in Jellyfin's HLS) + MediaSourceId (without it Jellyfin ignores
// the index); the first load plays Jellyfin's default track. Remux keeps
// stream copy of the chosen track.
// Auto (#162): the session's measured throughput (speed.ts) picks the rung
// (autoQuality); a load waits at most ~3 s for a running measurement. Source
// and the rungs ignore it, apart from Source's "may stutter" hint.
// Raw (#164, behind a setting): a profile with every codec, no probe; no
// fallbacks, a decode failure is an error naming the source codecs. Compatible
// mode disables Source and Raw (settings.quality() plays them as Auto).
// Subtitles (#136): Jellyfin offers one HLS rendition, for SubtitleStreamIndex
// (the first text subtitle until one is picked); another track reloads with
// it, Off and that track just switch hls.subtitleTrack. Starts Off.
// Screen mode (#180): `remote` feeds it a phone's pause/resume/seek/tracks
// commands, applied like the TV's own controls; play/stop are the screen's.
// `onState` gets the playback state about once a second and on every change
// (#181); a phone's pause holds through startup and reloads.
import { useEffect, useRef, useState } from 'react'
import { AppError, toAppError } from '../../errors'
import { ErrorView } from '../../ErrorView'
import Hls from 'hls.js'
import { tunnelJson } from '../../tunnel'
import { changed, diag, event, ranges, watchVideo } from '../../diag'
import { compatibleOn, quality, rawOn, setQuality } from '../../settings'
import type { Speed } from '../../speed'
import type { ScreenCommand, ScreenState } from '../gateways/api'
import { tunnelLoader, TUNNEL_ORIGIN } from './loader'
import { Controls } from './Controls'
import {
  autoCap,
  autoQuality,
  decision,
  describe,
  deviceProfile,
  limit,
  nowPlaying,
  probe,
  qualities,
  QUALITY,
  rawStatus,
  sourceHint,
  type Probe,
  type Quality,
  type Size,
} from './profile'
import {
  audioTracks,
  covers,
  subtitleTracks,
  STUCK_APPENDS,
  TICKS_PER_SECOND,
  type Item,
} from './items'

// Auto's video transcode output ceilings (e.g. the #81 fallback), set on the
// TranscodingUrl only when Jellyfin transcodes video; with a quality limit
// Jellyfin puts that limit there itself. Jellyfin only scales down and clamps
// the bitrate to the source's, so smaller sources keep their size. Never with
// stream copy: a bitrate there makes Jellyfin transcode anything above it.
const AUTO_TRANSCODE = {
  VideoBitrate: String(QUALITY['1080p'].bitrate),
  MaxHeight: String(QUALITY['1080p'].height),
  MaxWidth: String(QUALITY['1080p'].width),
}

type PlaybackInfo = {
  ErrorCode?: string
  MediaSources: {
    Id: string
    TranscodingUrl?: string
    Bitrate?: number
    MediaStreams: NonNullable<Item['MediaStreams']>
  }[]
}

/** Shows the current frame as the poster: a reload detaches the media, and
 * without it the box goes black and falls back to 300×150 until the new
 * stream's first frame (the poster also keeps the box's size). */
function freeze(v: HTMLVideoElement) {
  if (!v.videoWidth) return
  const c = document.createElement('canvas')
  c.width = v.videoWidth
  c.height = v.videoHeight
  try {
    c.getContext('2d')?.drawImage(v, 0, 0)
    v.poster = c.toDataURL('image/jpeg', 0.8)
  } catch {
    // no frame to copy: the reload just flickers
  }
}

/** What the current load may stream-copy; the fallbacks turn these off. */
type Copy = { video: boolean; audio: boolean }

const mbpsText = (mbps: number) =>
  mbps.toLocaleString(undefined, { maximumSignificantDigits: 2 })

export function Player({
  pc,
  speed,
  itemId,
  startTicks,
  remote,
  onState,
  onExit,
}: {
  pc: RTCPeerConnection
  speed?: Speed
  itemId: string
  startTicks?: number // unset: Jellyfin's saved position
  /** Subscribes to commands; returns the unsubscribe. Must be stable. */
  remote?: (apply: (c: ScreenCommand) => void) => () => void
  /** Playback state for the screen (#181). Read through a ref. */
  onState?: (s: ScreenState) => void
  onExit: (item: Item | null) => void
}) {
  const [item, setItem] = useState<Item | null>(null)
  const [blocked, setBlocked] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const [err, setErr] = useState<AppError | null>(null)
  const [q, setQ] = useState(quality)
  const [compat] = useState(compatibleOn) // as the effect reads it: once
  const [file, setFile] = useState<{ size: Size; bitrate?: number }>({
    size: { width: 0, height: 0 },
  })
  const [now, setNow] = useState<string>()
  // The measured link (Mbps) and Auto's pick from it, as of the last load.
  const [link, setLink] = useState<{ mbps?: number; auto: Quality }>({
    auto: 'Auto',
  })
  const pick = useRef<(q: Quality) => void>(() => {})
  // The audio menu: the item's tracks and the one playing (from the URL).
  const [tracks, setTracks] = useState<ReturnType<typeof audioTracks>>([])
  const [audio, setAudio] = useState('')
  const pickAudio = useRef<(index: number) => void>(() => {})
  // The subtitle menu: Off + the item's text subtitles, and the one shown.
  const [subs, setSubs] = useState<ReturnType<typeof subtitleTracks>>([])
  const [subtitle, setSubtitle] = useState('-1')
  const pickSub = useRef<(index: number) => void>(() => {})
  const stateRef = useRef(onState)
  useEffect(() => {
    stateRef.current = onState
  })

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
    let q = quality()
    let text: number | undefined // the subtitle stream Jellyfin offers via HLS
    let sub = -1 // the hls.js subtitle track: -1 off, 0 that one rendition
    let track: number | undefined // audio stream; unset = Jellyfin's default
    let source: string | undefined // Jellyfin ignores AudioStreamIndex without it
    let copy: Copy = { video: true, audio: true }
    let bitrate: number | undefined // the source's, bps (Auto's input)
    let playing: number | null = null // the audio stream the URL asks for
    let runTicks = 0
    let held = false // a phone paused: start() doesn't play
    const emit = () =>
      stateRef.current?.({
        itemId,
        positionTicks: Math.floor(v.currentTime * TICKS_PER_SECOND),
        durationTicks: runTicks,
        paused: v.paused,
        audio: playing,
        subtitle: sub < 0 ? -1 : (text ?? null),
      })
    let loads = 0 // only the latest start() attaches (quick quality switches)
    // Loads the stream at `at` seconds; called again by reload().
    const start = async (at: number) => {
      const load = ++loads
      const mbps = await speed?.get(q === 'Auto' ? 3000 : 0)
      if (gone || load !== loads) return
      const eff = q === 'Auto' ? autoQuality(mbps, bitrate) : q
      const cap = q === 'Auto' ? autoCap(mbps) : undefined
      setLink({ mbps, auto: eff })
      if (q === 'Auto' && mbps)
        event(
          `auto: link ~${mbps.toFixed(1)} Mbps${speed?.fresh() ? '' : ' (stored hint)'} → cap ${(cap! / 1e6).toFixed(1)} Mbps, source ${bitrate ? `${(bitrate / 1e6).toFixed(1)} Mbps` : '?'} → ${eff === 'Auto' ? 'no limit (fits)' : eff}`,
        )
      const max = limit(eff, compatible)
      const rate = Math.min(max?.bitrate ?? Infinity, cap ?? Infinity) / 1e6
      event(
        `quality: ${q}${max ? ` (≤${max.height}p, ${rate} Mbps)` : cap ? ` (≤${rate} Mbps)` : ' (no limit)'}`,
      )
      // Raw: always full copy, even after an earlier fallback (#164).
      const raw = eff === 'Raw'
      const allow: Copy = raw ? { video: true, audio: true } : copy
      // A new PlaySessionId each time, so Jellyfin starts a new job for new params.
      const info = await tunnelJson<PlaybackInfo>(
        pc,
        `/Items/${itemId}/PlaybackInfo`,
        {
          DeviceProfile: deviceProfile(
            caps,
            !allow.audio,
            compatible,
            eff,
            cap,
          ),
          EnableDirectPlay: false,
          EnableDirectStream: false,
          AllowVideoStreamCopy: allow.video,
          AllowAudioStreamCopy: allow.audio,
          ...(!allow.audio && { MaxAudioChannels: 2 }),
          ...(text !== undefined && { SubtitleStreamIndex: text }),
          ...(track !== undefined && {
            AudioStreamIndex: track,
            MediaSourceId: source,
          }),
        },
      )
      if (gone || load !== loads) return
      const src = info.MediaSources[0]
      if (!src?.TranscodingUrl)
        throw new AppError(
          'playback',
          `Jellyfin offers no stream (${info.ErrorCode ?? 'no TranscodingUrl'})`,
        )
      const [path, query] = src.TranscodingUrl.split('?')
      const params = new URLSearchParams(query)
      // Raw: no bitrate cap at all. Jellyfin transcodes a source of unknown
      // bitrate whenever VideoBitrate is set (spike on #164).
      if (raw) params.delete('VideoBitrate')
      const d = decision(`?${params}`, src.MediaStreams)
      event(`jellyfin: ${d.text}`)
      // Raw: no fallback; say what the device could not play.
      const rawErr = () =>
        setErr(
          new AppError(
            'playback',
            `This device can't play the original streams (${d.codecs}). Pick another quality.`,
          ),
        )
      const sv = src.MediaStreams.find((s) => s.Type === 'Video')
      const size = { width: sv?.Width ?? 0, height: sv?.Height ?? 0 }
      bitrate = src.Bitrate ?? sv?.BitRate
      setFile({ size, bitrate })
      source = src.Id
      setTracks(audioTracks(src.MediaStreams))
      setAudio(params.get('AudioStreamIndex') ?? '')
      playing = params.has('AudioStreamIndex')
        ? Number(params.get('AudioStreamIndex'))
        : null
      emit()
      if (!d.videoCopy && !max) {
        Object.entries(AUTO_TRANSCODE).forEach(([k, val]) => params.set(k, val))
        if (cap)
          params.set(
            'VideoBitrate',
            String(Math.min(cap, QUALITY['1080p'].bitrate)),
          )
      }
      if (!d.videoCopy)
        event(
          `transcode to ≤${params.get('MaxHeight') ?? '?'}p, ${params.get('VideoBitrate')} bps`,
        )
      setNow(
        raw && d.videoCopy
          ? rawStatus(d.codecs)
          : nowPlaying(d.videoCopy, params, size),
      )
      h = new Hls({
        loader: tunnelLoader(pc),
        startPosition: at,
        renderTextTracksNatively: true,
        // hls.js grows the forward buffer up to 600 s for low bitrates; a TV's
        // MSE quota fills long before that (bufferFullError on webOS).
        maxMaxBufferLength: 60,
      })
      h.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_e, d) => {
        event(
          `hls subtitles: ${d.subtitleTracks.map((t) => t.name || t.lang || t.id).join(', ') || 'none'}`,
        )
        // Set once the tracks exist: before that hls.js drops the id.
        if (h && d.subtitleTracks.length) h.subtitleTrack = sub
      })
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
        if (raw && e.type === Hls.ErrorTypes.MEDIA_ERROR && (e.fatal || audio))
          return rawErr()
        if (copy.audio && audio && e.type === Hls.ErrorTypes.MEDIA_ERROR)
          return reload('fallback: stereo AAC', { audio: false })
        if (e.fatal)
          setErr(new AppError('playback', `playback error: ${e.details}`))
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
          if (raw) rawErr()
          else reload('fallback: video transcode', { video: false })
      })
      h.attachMedia(v)
      h.loadSource(`${TUNNEL_ORIGIN}${path}?${params}`)
      // Autoplay is blocked without a user gesture (deep link / reload): the
      // control bar stays up with Play focused, one Enter/tap starts it.
      if (!held) v.play().catch(refused)
    }
    const refused = (e: Error) => {
      event(`autoplay blocked: ${e.name}`)
      setBlocked(true)
    }

    // Restarts at the playhead: with less stream copy (the fallbacks), another
    // quality or audio track. Keeps the other choices.
    const reload = (why: string, less: Partial<Copy> = {}) => {
      if (!caps) return // still starting: the first load picks it up
      const t = v.currentTime
      event(`${why} @${t.toFixed(1)}`)
      setErr(null) // a new load: e.g. Raw failed, another quality picked
      copy = { ...copy, ...less }
      freeze(v)
      const old = h
      h = null // no position reports while the media detaches
      old?.destroy()
      start(t).catch((e) => setErr(toAppError(e)))
    }
    pick.current = (next) => {
      q = next
      reload(`quality: switch to ${next}`)
    }
    pickAudio.current = (index) => {
      track = index
      reload(`audio: switch to stream ${index}`)
    }
    pickSub.current = (index) => {
      sub = index < 0 ? -1 : 0
      if (index < 0 || index === text) {
        event(`subtitles: ${index < 0 ? 'off' : `stream ${index}`}`)
        if (h) h.subtitleTrack = sub // no tracks yet: the update above sets it
        return emit()
      }
      text = index
      reload(`subtitles: switch to stream ${index}`)
    }
    const unremote = remote?.((c) => {
      if (c.type === 'pause') {
        held = true
        v.pause()
        emit()
      } else if (c.type === 'resume') {
        held = false
        v.play().catch(refused)
      } else if (c.type === 'seek') v.currentTime = c.ticks / TICKS_PER_SECOND
      else if (c.type === 'tracks') {
        if (c.audio !== undefined) {
          setAudio(String(c.audio))
          pickAudio.current(c.audio)
        }
        if (c.subtitle !== undefined) {
          setSubtitle(String(c.subtitle))
          pickSub.current(c.subtitle)
        }
      }
    })

    ;(async () => {
      if (!Hls.isSupported())
        throw new AppError(
          'playback',
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
      runTicks = fresh.RunTimeTicks ?? 0
      bitrate =
        fresh.MediaSources?.[0]?.Bitrate ??
        fresh.MediaStreams?.find((s) => s.Type === 'Video')?.BitRate
      const st = subtitleTracks(fresh.MediaStreams)
      setSubs(st)
      text = st[1] && Number(st[1].value)
      await start(
        (startTicks ?? fresh.UserData?.PlaybackPositionTicks ?? 0) /
          TICKS_PER_SECOND,
      )
    })().catch((e) => setErr(toAppError(e)))

    const unwatch = watchVideo(v)
    const tick = setInterval(report, 10_000)
    const ended = () => save({ Played: true, PlaybackPositionTicks: 0 })
    const onPlay = () => {
      held = false
      setBlocked(false)
    }
    const state = setInterval(() => stateRef.current && emit(), 1000)
    const changes = ['play', 'pause', 'seeked', 'ended']
    changes.forEach((e) => v.addEventListener(e, emit))
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', report)
    v.addEventListener('seeked', report)
    v.addEventListener('ended', ended)
    window.addEventListener('pagehide', report)
    return () => {
      gone = true
      unremote?.()
      unwatch()
      clearInterval(tick)
      clearInterval(state)
      changes.forEach((e) => v.removeEventListener(e, emit))
      report()
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', report)
      v.removeEventListener('seeked', report)
      v.removeEventListener('ended', ended)
      window.removeEventListener('pagehide', report)
      h?.destroy()
    }
  }, [pc, speed, itemId, startTicks, remote])

  return (
    <div>
      <h3>{item?.Name}</h3>
      <Controls
        video={video}
        duration={(item?.RunTimeTicks ?? 0) / TICKS_PER_SECOND}
        blocked={blocked}
        settings={[
          {
            name: 'Quality',
            value: q,
            status: now,
            options: qualities(file.size, q, rawOn()).map((o) => ({
              value: o,
              label:
                o === 'Auto' && link.mbps
                  ? `Auto${link.auto === 'Auto' ? '' : ` · ${link.auto}`} (your connection ~${mbpsText(link.mbps)} Mbps)`
                  : o,
              hint: QUALITY[o]
                ? `${(QUALITY[o].bitrate / 1e6).toLocaleString()} Mbps`
                : o === 'Source'
                  ? [
                      sourceHint(file.size, file.bitrate) || 'no limit',
                      link.mbps &&
                        (file.bitrate ?? 0) > link.mbps * 1e6 &&
                        'faster than your connection, may stutter',
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : o === 'Raw'
                    ? 'original streams, unchecked'
                    : 'no limit',
              ...(compat &&
                (o === 'Source' || o === 'Raw') && {
                  disabled: true,
                  hint: 'Off in compatible mode — turn it off in Settings',
                }),
            })),
            pick: (v) => {
              const next = v as Quality
              setQ(next)
              setNow(undefined) // until the reload's decision
              setQuality(next)
              pick.current(next)
            },
          },
          // Only with a choice to make: one track = no entry.
          ...(tracks.length > 1
            ? [
                {
                  name: 'Audio',
                  value: audio,
                  options: tracks,
                  pick: (v: string) => {
                    setAudio(v)
                    pickAudio.current(Number(v))
                  },
                },
              ]
            : []),
          // Only with a text subtitle: Off alone = no entry.
          ...(subs.length > 1
            ? [
                {
                  name: 'Subtitles',
                  value: subtitle,
                  options: subs,
                  pick: (v: string) => {
                    setSubtitle(v)
                    pickSub.current(Number(v))
                  },
                },
              ]
            : []),
        ]}
        onBack={() => onExit(item)}
      >
        <video ref={video} />
      </Controls>
      {blocked && <p>Press play to start.</p>}
      {err && <ErrorView error={err} />}
    </div>
  )
}
