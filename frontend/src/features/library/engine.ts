// HLS playback through the tunnel, for one Player effect run. Jellyfin decides
// remux vs transcode from a DeviceProfile built from a capability probe
// (profile.ts, #115); hls.js plays the TranscodingUrl it returns via the
// tunnel loader.
// Resume: start at Jellyfin's saved position; reporting is resume.ts.
// Fallback (#81): some devices (webOS TV, Chrome 87) drop stream-copied video
// after a seek/resume. When video appends stop covering the playhead, reload
// there with a video transcode for the rest of this playback.
// Audio fallback (#115): on an audio decode/append error, reload there with
// stereo AAC (no audio copy) for the rest of this playback.
// Compatible escalation (#238): a failure after one of those fallbacks reloads
// once more with the compatible profile and no stream copy (H.264 + stereo AAC
// in .ts, ≤1080p) for the rest of this playback; a failure after that is the
// error. Not in Raw or compatible mode. Debug: ?fail=<n> makes the first n
// loads look stuck. The chain is decided by onFailure() (profile.ts).
// Quality (#108): the picker's limit goes into the profile; a switch reloads at
// the playhead the same way (Jellyfin serves one HLS level per load).
// Audio (#109): the same reload with AudioStreamIndex (no switchable audio
// renditions in Jellyfin's HLS) + MediaSourceId (without it Jellyfin ignores
// the index); the first load plays Jellyfin's default track, or a track of
// its language this device decodes when it can't (autoAudio, #252; not in Raw
// or compatible mode). Remux keeps stream copy of the chosen track.
// Auto (#162): the session's measured throughput (speed.ts) picks the rung
// (autoQuality); a load waits at most ~3 s for a running measurement. Source
// and the rungs ignore it, apart from Source's "may stutter" hint.
// Raw (#164, behind a setting): a profile with every codec, no probe; no
// fallbacks, a decode failure is an error naming the source codecs. Compatible
// mode disables Source and Raw (settings.quality() plays them as Auto).
// Subtitles (#136): subtitles.ts; a pick never reloads. Starts Off.
// Screen mode (#180): `remote` feeds it a phone's pause/resume/seek/tracks
// commands, applied like the TV's own controls; play/stop are the screen's.
// The state goes to `onState` about once a second and on every change (#181);
// a phone's pause holds through startup and reloads.
import Hls from 'hls.js'
import { queryClient } from '../../query'
import { AppError, toAppError } from '../../errors'
import { tunnelJson } from '../../tunnel'
import { event, failLoads, watchVideo } from '../../diag'
import { compatibleOn, dataSaverOn, quality } from '../../settings'
import type { Speed } from '../../speed'
import type { ScreenCommand, ScreenState } from '../gateways/api'
import { TUNNEL_ORIGIN } from './loader'
import * as jf from './jellyfin'
import { playback } from './art'
import { newHls } from './hls'
import { watchResume } from './resume'
import { subtitleTrack } from './subtitles'
import type { Link } from './quality'
import { autoLine, qualityLine, transcodeParams, urlAudio } from './stream'
import {
  audioCodecs,
  autoAudio,
  autoCap,
  autoQuality,
  effective,
  decision,
  describe,
  deviceProfile,
  escalates,
  onFailure,
  type Copy,
  type Failure,
  limit,
  nowPlaying,
  probe,
  rawStatus,
  type Probe,
  type Quality,
  type Size,
} from './profile'
import {
  audioTracks,
  subtitleTracks,
  TICKS_PER_SECOND,
  type Item,
} from './items'

/** What the Player shows; the engine sets parts of it. */
export type View = {
  item: Item | null
  blocked: boolean // autoplay refused: "Press play"
  err: AppError | null
  file: { size: Size; bitrate?: number }
  now?: string // what plays, for the quality picker
  link: Link
  tracks: ReturnType<typeof audioTracks> // the audio menu
  audio: string // the audio stream playing (from the URL)
  subs: ReturnType<typeof subtitleTracks> // Off + the text subtitles
  subtitle: string // the one shown
}

export const START_VIEW: View = {
  item: null,
  blocked: false,
  err: null,
  file: { size: { width: 0, height: 0 } },
  link: { auto: 'Auto' },
  tracks: [],
  audio: '',
  subs: [],
  subtitle: '-1',
}

type PlayInfo = jf.PlaybackInfo['MediaSources'][number]

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

export class Engine {
  private h: Hls | null = null
  private gone = false
  // The playback's choices and what the current load plays.
  private caps?: Probe
  private compatible = compatibleOn() // read once: applies from the next playback
  private escalated = false // compatible since a fallback failed (#238)
  private q = quality()
  private sub = -1 // the subtitle stream shown, -1 off
  private track?: number // audio stream; unset = Jellyfin's default
  private source?: string // Jellyfin ignores AudioStreamIndex without it
  private copy: Copy = { video: true, audio: true }
  private bitrate?: number // the source's, bps (Auto's input)
  private playing: number | null = null // the audio stream the URL asks for
  private runTicks = 0
  private held = false // paused: start() doesn't play
  private seekTo?: number // a phone's seek while nothing is attached
  private at0 = 0 // where the current load starts, seconds
  private loads = 0 // only the latest start() attaches (quick quality switches)

  private readonly pc: RTCPeerConnection
  private readonly v: HTMLVideoElement
  private readonly itemId: string
  private readonly speed?: Speed
  private readonly set: (p: Partial<View>) => void
  /** The screen's state callback (#181), read on each emit. */
  private readonly onState: () => ((s: ScreenState) => void) | undefined
  private readonly subs: ReturnType<typeof subtitleTrack>

  constructor(d: {
    pc: RTCPeerConnection
    v: HTMLVideoElement
    itemId: string
    speed?: Speed
    set: (p: Partial<View>) => void
    onState: () => ((s: ScreenState) => void) | undefined
  }) {
    this.pc = d.pc
    this.v = d.v
    this.itemId = d.itemId
    this.speed = d.speed
    this.set = d.set
    this.onState = d.onState
    this.subs = subtitleTrack(d.pc, d.v, d.itemId)
  }

  /** Starts playback; returns the teardown. `remote` subscribes to a phone's
   * commands and returns the unsubscribe. */
  open(
    gatewayId: string,
    startTicks?: number,
    remote?: (apply: (c: ScreenCommand) => void) => () => void,
  ) {
    const v = this.v
    const at = Date.now()
    playback.set(gatewayId, { at })
    // A read still in flight predates this playback: drop its result (#378).
    void queryClient.cancelQueries({ queryKey: ['tunnel', gatewayId] })
    const unremote = remote?.(this.command)
    this.init(startTicks).catch((e) => this.set({ err: toAppError(e) }))
    const unwatch = watchVideo(v)
    const unresume = watchResume(this.pc, v, this.itemId, () => !!this.h)
    const state = setInterval(() => this.onState() && this.emit(), 1000)
    const on: [string, () => void][] = [
      ...['play', 'pause', 'seeked', 'ended'].map(
        (e) => [e, this.emit] as [string, () => void],
      ),
      ['play', this.onPlay],
    ]
    on.forEach(([e, f]) => v.addEventListener(e, f))
    return () => {
      this.gone = true
      unremote?.()
      unwatch()
      clearInterval(state)
      // The pages left behind refetch, after the exit save (#360, #378).
      playback.set(gatewayId, { at, saved: unresume() })
      void queryClient.invalidateQueries({ queryKey: ['tunnel', gatewayId] })
      on.forEach(([e, f]) => v.removeEventListener(e, f))
      this.h?.destroy()
      this.subs.close()
    }
  }

  // Startup: probe, a fresh item (the listing's resume position may be
  // stale), the audio track, then the first load.
  private async init(startTicks?: number) {
    if (!Hls.isSupported())
      throw new AppError(
        'playback',
        'this browser has no MSE (iOS Safari is not supported yet)',
      )
    if (this.compatible) event('compatible mode: on')
    const caps = await probe()
    this.caps = caps
    event(`probe: ${describe(caps)}`)
    deviceProfile(caps, false, this.compatible) // throws without H.264, before anything loads
    const fresh = await tunnelJson<Item>(this.pc, jf.item(this.itemId))
    if (this.gone) return
    this.set({ item: fresh, subs: subtitleTracks(fresh.MediaStreams) })
    this.runTicks = fresh.RunTimeTicks ?? 0
    const ms = fresh.MediaSources?.[0]
    this.bitrate =
      ms?.Bitrate ??
      fresh.MediaStreams?.find((s) => s.Type === 'Video')?.BitRate
    const auto =
      this.compatible || this.q === 'Raw' || this.track !== undefined
        ? undefined
        : autoAudio(
            fresh.MediaStreams,
            ms?.DefaultAudioStreamIndex,
            audioCodecs(caps),
            caps.surround,
          )
    if (auto !== undefined) {
      this.track = auto
      this.source = ms?.Id
      event(`audio: default not decodable, stream ${auto} instead`)
    }
    await this.start(
      (startTicks ?? fresh.UserData?.PlaybackPositionTicks ?? 0) /
        TICKS_PER_SECOND,
    )
  }

  // Media loaded: else (starting, reloading) the element says 0 / paused.
  private live = () => !!this.h && this.v.readyState > 0
  private now = () =>
    this.live() ? this.v.currentTime : (this.seekTo ?? this.at0)

  private emit = () =>
    this.onState()?.({
      itemId: this.itemId,
      positionTicks: Math.floor(this.now() * TICKS_PER_SECOND),
      durationTicks: this.runTicks,
      paused: this.live() ? this.v.paused : this.held,
      audio: this.track ?? this.playing, // the requested one, like the subtitle
      subtitle: this.sub,
    })

  // Loads the stream at `at` seconds; called again by reload().
  private async start(at: number) {
    const load = ++this.loads
    this.at0 = at
    const q = this.q
    const mbps = await this.speed?.get(q === 'Auto' ? 3000 : 0)
    if (this.gone || load !== this.loads) return
    const saver = dataSaverOn() // #291: caps Auto only (effective)
    const bitrate = this.bitrate
    const eff = effective(q, mbps, bitrate, saver)
    const cap = q === 'Auto' ? autoCap(mbps) : undefined
    // Auto's pick, also while a rung is picked.
    this.set({ link: { mbps, auto: autoQuality(mbps, bitrate, saver), saver } })
    if (q === 'Auto' && (mbps || saver))
      event(
        autoLine({
          mbps,
          fresh: this.speed?.fresh(),
          cap,
          bitrate,
          saver,
          eff,
        }),
      )
    const max = limit(eff, this.compatible)
    event(qualityLine(q, max, cap))
    // Raw: always full copy, even after an earlier fallback (#164).
    const raw = eff === 'Raw' && !this.compatible // the picker after an escalation
    const allow: Copy = raw ? { video: true, audio: true } : this.copy
    // A new PlaySessionId each time, so Jellyfin starts a new job for new params.
    const info = await tunnelJson<jf.PlaybackInfo>(
      this.pc,
      jf.playbackInfo(this.itemId),
      {
        DeviceProfile: deviceProfile(
          this.caps!,
          !allow.audio,
          this.compatible,
          eff,
          cap,
        ),
        EnableDirectPlay: false,
        EnableDirectStream: false,
        AllowVideoStreamCopy: allow.video,
        AllowAudioStreamCopy: allow.audio,
        ...(!allow.audio && { MaxAudioChannels: 2 }),
        // None in the stream: else Jellyfin picks a default/forced one and,
        // image subtitles being Encode-only here, burns it in. Ours: <track>.
        SubtitleStreamIndex: -1,
        ...(this.track !== undefined && {
          AudioStreamIndex: this.track,
          MediaSourceId: this.source,
        }),
      },
    )
    if (this.gone || load !== this.loads) return
    const src = info.MediaSources[0]
    if (!src?.TranscodingUrl)
      throw new AppError(
        'playback',
        `Jellyfin offers no stream (${info.ErrorCode ?? 'no TranscodingUrl'})`,
      )
    this.attach(load, at, src, { raw, limited: !!max, cap })
  }

  // Plays the load's TranscodingUrl: final params, the picker's state, hls.js.
  private attach(
    load: number,
    at: number,
    src: PlayInfo,
    o: { raw: boolean; limited: boolean; cap?: number },
  ) {
    const [path, query] = src.TranscodingUrl!.split('?')
    const params = new URLSearchParams(query)
    // Raw: no bitrate cap at all. Jellyfin transcodes a source of unknown
    // bitrate whenever VideoBitrate is set (spike on #164).
    if (o.raw) params.delete('VideoBitrate')
    const d = decision(`?${params}`, src.MediaStreams)
    event(`jellyfin: ${d.text}`)
    const sv = src.MediaStreams.find((s) => s.Type === 'Video')
    const size = { width: sv?.Width ?? 0, height: sv?.Height ?? 0 }
    this.bitrate = src.Bitrate ?? sv?.BitRate
    this.source = src.Id
    this.playing = urlAudio(params)
    this.set({
      file: { size, bitrate: this.bitrate },
      tracks: audioTracks(src.MediaStreams),
      audio: params.get('AudioStreamIndex') ?? '',
    })
    this.emit()
    transcodeParams(params, d.videoCopy, o.limited, o.cap)
    if (!d.videoCopy)
      event(
        `transcode to ≤${params.get('MaxHeight') ?? '?'}p, ${params.get('VideoBitrate')} bps`,
      )
    this.set({
      now:
        o.raw && d.videoCopy
          ? rawStatus(d.codecs)
          : nowPlaying(d.videoCopy, params, size),
    })
    const forced = load <= failLoads() // debug: ?fail=<n>
    this.h = newHls(this.pc, this.v, {
      startPosition: this.seekTo ?? at,
      // Stream copy, or a transcode after a fallback (may escalate or fail, #238).
      watch:
        d.videoCopy ||
        this.escalated ||
        escalates(this.copy, this.compatible) ||
        forced,
      forced,
      failed: this.failure(o.raw, d.codecs),
    })
    this.seekTo = undefined
    this.h.attachMedia(this.v)
    this.h.loadSource(`${TUNNEL_ORIGIN}${path}?${params}`)
    // Autoplay is blocked without a user gesture (deep link / reload): the
    // control bar stays up with Play focused, one Enter/tap starts it.
    if (!this.held) this.v.play().catch(this.refused)
  }

  // One load's failure handler: the fallback chain decides (onFailure), this
  // carries it out.
  private failure(raw: boolean, codecs: string) {
    let over = false // the chain ended in an error: this load is done (#552)
    return (f: Failure) => {
      if (over) return
      const { copy, compatible, escalated } = this
      const n = onFailure(f, { raw, copy, compatible, escalated })
      if (!n) return
      if ('reload' in n) {
        if (n.escalate) this.compatible = this.escalated = true
        return this.reload(n.reload, n.less)
      }
      // Stop fetching over the tunnel (and Jellyfin transcoding); keeps the
      // buffered picture. A reload (another quality) starts a fresh load.
      over = true
      this.h?.stopLoad()
      event('load stopped: playback error')
      const msg =
        'raw' in n // Raw: say what the device could not play
          ? `This device can't play the original streams (${codecs}). Pick another quality.`
          : n.error
      this.set({ err: new AppError('playback', msg) })
    }
  }

  private refused = (e: Error) => {
    event(`autoplay blocked: ${e.name}`)
    this.set({ blocked: true })
  }

  // Restarts at the playhead: with less stream copy (the fallbacks), another
  // quality or audio track. Keeps the other choices.
  private reload(why: string, less: Partial<Copy> = {}) {
    if (!this.caps) return // still starting: the first load picks it up
    const t = this.now()
    if (this.live()) this.held = this.v.paused // else keep: a reload in flight paused it
    event(`${why} @${t.toFixed(1)}`)
    this.set({ err: null }) // a new load: e.g. Raw failed, another quality picked
    this.copy = { ...this.copy, ...less }
    freeze(this.v)
    const old = this.h
    this.h = null // no position reports while the media detaches
    old?.destroy()
    this.start(t).catch((e) => this.set({ err: toAppError(e) }))
  }

  pickQuality(next: Quality) {
    this.q = next
    this.reload(`quality: switch to ${next}`)
  }

  pickAudio(index: number) {
    this.track = index
    this.reload(`audio: switch to stream ${index}`)
  }

  pickSub(index: number) {
    this.sub = index
    event(`subtitles: ${index < 0 ? 'off' : `stream ${index}`}`)
    this.emit()
    this.subs.show(index, this.source)
  }

  // A phone's command (screen mode, #180), applied like the TV's own controls.
  private command = (c: ScreenCommand) => {
    const v = this.v
    if (c.type === 'pause') {
      this.held = true
      v.pause()
      this.emit()
    } else if (c.type === 'resume') {
      this.held = false
      v.play().catch(this.refused)
    } else if (c.type === 'seek') {
      if (this.h) v.currentTime = c.ticks / TICKS_PER_SECOND
      else this.seekTo = c.ticks / TICKS_PER_SECOND // start() picks it up
    } else if (c.type === 'tracks') {
      if (c.audio !== undefined) {
        this.set({ audio: String(c.audio) })
        this.pickAudio(c.audio)
      }
      if (c.subtitle !== undefined) {
        this.set({ subtitle: String(c.subtitle) })
        this.pickSub(c.subtitle)
      }
    }
  }

  private onPlay = () => {
    this.held = false
    this.set({ blocked: false })
  }
}
