// Subtitles: the picked text subtitle as WebVTT (Jellyfin's Stream.vtt,
// over the tunnel) in our own <track>; a pick never reloads. Not Jellyfin's
// HLS rendition: hls.js maps its X-TIMESTAMP-MAP (MPEGTS:900000) against
// segment timestamps that shift with where the transcode job started, so its
// cues landed seconds off. Stream.vtt is in content time, which is the
// playlist's and so the <video>'s.
import { event } from '../../shared/diag'
import { tunnelFetch } from '../../shared/tunnel'
import * as jf from '../library/jellyfin'

/** The subtitle <track> of `v`: show(index, source) fetches and shows one
 * (-1 = off); close() removes it for good. */
export function subtitleTrack(
  pc: RTCPeerConnection,
  v: HTMLVideoElement,
  itemId: string,
) {
  let vtt: HTMLTrackElement | undefined
  let current = -1
  let closed = false
  const hide = () => {
    if (!vtt) return
    vtt.track.mode = 'disabled' // Chrome keeps showing a removed track's cues
    URL.revokeObjectURL(vtt.src)
    vtt.remove()
    vtt = undefined
  }
  const show = (index: number, source?: string) => {
    current = index
    hide()
    if (index < 0) return
    // ponytail: no media source yet (a phone's pick during startup) = the
    // item's id, which is its one source's; multi-version items then get
    // the default version's subtitle.
    tunnelFetch(pc, jf.subtitle(itemId, source ?? itemId, index))
      .then((r) => {
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
        if (closed || current !== index) return // picked again meanwhile
        hide()
        vtt = document.createElement('track')
        vtt.kind = 'subtitles'
        vtt.src = URL.createObjectURL(new Blob([r.body], { type: 'text/vtt' }))
        v.append(vtt)
        vtt.track.mode = 'showing'
      })
      .catch((e) => event(`subtitles: stream ${index} failed: ${e}`))
  }
  const close = () => {
    closed = true
    hide()
  }
  return { show, close }
}
