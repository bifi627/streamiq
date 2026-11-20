// First-visit TV guess from the user agent. It only picks the TV-mode default
// while nothing is stored; nothing else may read it (owner decision: no other
// user-agent sniffing in the UI).
export type TvGuess = 'tv' | 'unsure' | 'other'

const TV_MARKERS = /webOS|Web0S|Tizen|SmartTV|SMART-TV/i

/** Known TV markers → 'tv'; Android without "Mobile" and no touch screen
 * (Android TV / Google TV; a tablet has touch) → 'unsure'; else 'other'. */
export function guessTv(ua: string, maxTouchPoints: number): TvGuess {
  if (TV_MARKERS.test(ua)) return 'tv'
  if (/Android/.test(ua) && !/Mobile/.test(ua) && maxTouchPoints === 0)
    return 'unsure'
  return 'other'
}
