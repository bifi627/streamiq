// The hls.js instance of one load: fetches over the tunnel, logs what the
// device is asked to decode, shows the buffer state in the diagnostics, and
// reports failures (errors and stuck video appends) to the fallback
// chain (onFailure, profile.ts).
import Hls from 'hls.js'
import { changed, diag, event, ranges } from '../../diag'
import { tunnelLoader } from './loader'
import type { Failure } from './profile'
import { covers, STUCK_APPENDS } from './items'

export function newHls(
  pc: RTCPeerConnection,
  v: HTMLVideoElement,
  o: {
    startPosition: number
    watch: boolean // count stuck appends: stream copy or a fallback
    forced: boolean // debug: ?fail=<n> makes this load look stuck
    failed: (f: Failure) => void
  },
) {
  const h = new Hls({
    loader: tunnelLoader(pc),
    startPosition: o.startPosition,
    // hls.js grows the forward buffer up to 600 s for low bitrates; a TV's
    // MSE quota fills long before that (bufferFullError on webOS).
    maxMaxBufferLength: 60,
    // Forward buffer = max(maxBufferSize (60 MB) in seconds at the level bitrate,
    // maxBufferLength). The default 30 s floor is ~230 MB at 4K/60 Mbps, past
    // Chrome's ~150 MB MSE quota (bufferFullError, re-fetches); a 4 s floor lets the
    // 60 MB budget rule (≤ 8 Mbps still gets 60 s). No backBufferLength: the browser
    // and hls.js evict played media on a full buffer (a 10 s cap made 1080p re-fetch
    // on a seek back).
    maxBufferLength: 4,
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
    o.failed({
      media: e.type === Hls.ErrorTypes.MEDIA_ERROR,
      fatal: e.fatal,
      audio,
      details: e.details,
    })
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
    if (!o.watch || (a.type !== 'video' && a.type !== 'audiovideo')) return
    if (!o.forced && covers(a.timeRanges[a.type], v.currentTime)) stuck = 0
    else if (++stuck >= STUCK_APPENDS) o.failed('stuck')
  })
  return h
}
