// Resume: report the position every 10 s, on pause, seek and exit,
// straight to the viewer's UserData (/Sessions/Playing* is not on the gateway
// allowlist), with LastPlayedDate (Continue watching sorts by it) and
// Played: false (a partial rewatch is in progress again). Only once this
// playback has really played watchMin() (60 s): clicking through saves
// nothing. The end marks the item played.
import { event, watchMin } from '../../diag'
import { tunnelJson } from '../../tunnel'
import * as jf from './jellyfin'
import { TICKS_PER_SECOND } from './items'

/** Starts reporting `v`'s position for `itemId` while `attached()` (no
 * reports while a reload detaches the media). The returned stop reports
 * once more and returns the last save, for the pages left behind. */
export function watchResume(
  pc: RTCPeerConnection,
  v: HTMLVideoElement,
  itemId: string,
  attached: () => boolean,
) {
  const min = watchMin()
  let lastSaved = -1
  let played = 0 // seconds really played: playhead steps, not seeks or pauses
  let lastT = -Infinity
  let saving: Promise<unknown> = Promise.resolve()
  const onTime = () => {
    const t = v.currentTime
    if (!v.seeking && t > lastT && t - lastT < 1) played += t - lastT
    lastT = t
  }
  const save = (body: object) =>
    (saving = tunnelJson(pc, jf.userData(itemId), body).catch((e) =>
      event(`resume: save failed: ${e}`),
    ))
  const report = () => {
    const t = Math.floor(v.currentTime)
    // Not after the end: its `pause` comes before `ended` (Played: true).
    if (attached() && t > 0 && t !== lastSaved && played >= min && !v.ended) {
      lastSaved = t
      save({
        PlaybackPositionTicks: t * TICKS_PER_SECOND,
        Played: false,
        LastPlayedDate: new Date().toISOString(),
      })
    }
  }
  const ended = () => save({ Played: true, PlaybackPositionTicks: 0 })
  const on: [string, () => void][] = [
    ['timeupdate', onTime],
    ['pause', report],
    ['seeked', report],
    ['ended', ended],
  ]
  on.forEach(([e, f]) => v.addEventListener(e, f))
  window.addEventListener('pagehide', report)
  const tick = setInterval(report, 10_000)
  return () => {
    clearInterval(tick)
    report()
    on.forEach(([e, f]) => v.removeEventListener(e, f))
    window.removeEventListener('pagehide', report)
    return saving
  }
}
