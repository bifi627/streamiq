// The player's quality picker (#108, #161): which options, their labels and
// hints. Auto names the measured link and its pick (#162, #291); Source warns
// when it is faster than the link; compatible mode disables Source and Raw
// (#113, #164).
import {
  QUALITY,
  qualities,
  sourceHint,
  type Quality,
  type Size,
} from './profile.ts'

/** The measured link (Mbps) and Auto's pick from it, as of the last load. */
export type Link = { mbps?: number; auto: Quality; saver?: boolean }

export type Option = {
  value: Quality
  label: string
  hint: string
  disabled?: boolean
}

const mbpsText = (mbps: number) =>
  mbps.toLocaleString(undefined, { maximumSignificantDigits: 2 })

const join = (parts: unknown[]) => parts.filter(Boolean).join(', ')

function label(o: Quality, link: Link) {
  if (o !== 'Auto' || !(link.mbps || link.saver)) return o
  const pick = link.auto === 'Auto' ? '' : ` · ${link.auto}`
  const why = join([
    link.saver && 'data saver',
    link.mbps && `your connection ~${mbpsText(link.mbps)} Mbps`,
  ])
  return `Auto${pick} (${why})`
}

function hint(o: Quality, file: { size: Size; bitrate?: number }, link: Link) {
  const r = QUALITY[o]
  if (r) return `${(r.bitrate / 1e6).toLocaleString()} Mbps`
  if (o === 'Raw') return 'original streams, unchecked'
  if (o !== 'Source') return 'no limit'
  return [
    sourceHint(file.size, file.bitrate) || 'no limit',
    link.mbps &&
      (file.bitrate ?? 0) > link.mbps * 1e6 &&
      'faster than your connection, may stutter',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The picker's options for the source `file` while `current` is picked. */
export function qualityOptions(
  file: { size: Size; bitrate?: number },
  current: Quality,
  link: Link,
  raw: boolean,
  compatible: boolean,
): Option[] {
  return qualities(file.size, current, raw).map((o) => ({
    value: o,
    label: label(o, link),
    hint: hint(o, file, link),
    ...(compatible &&
      (o === 'Source' || o === 'Raw') && {
        disabled: true,
        hint: 'Off in compatible mode — turn it off in Settings',
      }),
  }))
}
