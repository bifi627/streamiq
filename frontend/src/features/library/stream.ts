// One load's TranscodingUrl params and its log lines (the Player's start()).
import { QUALITY, type Quality } from './profile.ts'

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

const mbps = (bps: number) => `${(bps / 1e6).toFixed(1)} Mbps`

/** Auto's log line: the link, its cap, the source and what Auto plays. */
export function autoLine(a: {
  mbps?: number
  fresh?: number // measured this session (else the stored hint)
  cap?: number // bps
  bitrate?: number // the source's, bps
  saver: boolean
  eff: Quality
}) {
  const link = a.mbps
    ? `~${a.mbps.toFixed(1)} Mbps${a.fresh ? '' : ' (stored hint)'} → cap ${mbps(a.cap!)}`
    : 'unknown'
  const src = a.bitrate ? mbps(a.bitrate) : '?'
  const saver = a.saver ? ', data saver on' : ''
  const plays = a.eff === 'Auto' ? 'no limit (fits)' : a.eff
  return `auto: link ${link}, source ${src}${saver} → ${plays}`
}

/** The quality log line: the picked one and the limit it sets. */
export function qualityLine(
  q: Quality,
  max: { height: number; bitrate: number } | null | undefined,
  cap?: number,
) {
  const rate = Math.min(max?.bitrate ?? Infinity, cap ?? Infinity) / 1e6
  if (max) return `quality: ${q} (≤${max.height}p, ${rate} Mbps)`
  return `quality: ${q}${cap ? ` (≤${rate} Mbps)` : ' (no limit)'}`
}

/** Sets the final TranscodingUrl params: a video transcode without a
 * quality limit gets Auto's ceilings, its bitrate at most Auto's `cap` (bps). */
export function transcodeParams(
  params: URLSearchParams,
  videoCopy: boolean,
  limited: boolean,
  cap?: number,
) {
  if (videoCopy || limited) return
  Object.entries(AUTO_TRANSCODE).forEach(([k, val]) => params.set(k, val))
  if (cap)
    params.set('VideoBitrate', String(Math.min(cap, QUALITY['1080p'].bitrate)))
}

/** The audio stream the URL asks for; null = Jellyfin's default. */
export const urlAudio = (params: URLSearchParams) =>
  params.has('AudioStreamIndex') ? Number(params.get('AudioStreamIndex')) : null
