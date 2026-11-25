// TV mode decides per route, not per element: a route not listed here is
// TV-off until it's added (a new manage page can't leak onto the TV).
export type TvRoute = 'allow' | 'handoff'

const ALLOWED = ['/settings', '/settings/playback', '/diagnostics', '/gateways']
// Open in no household: the per-device settings and /join (the way in).
const HOMELESS = ['/settings', '/settings/playback', '/join']

export function tvRoute(pathname: string): TvRoute {
  const p = pathname.replace(/\/+$/, '') || '/'
  return p === '/' || p === '/g' || p.startsWith('/g/') || ALLOWED.includes(p)
    ? 'allow'
    : 'handoff'
}

/** What the shell shows in place of the route. `handoff`: the current URL;
 * `handoffHousehold`: the households overview's URL (TV mode, no household). */
export type ShellPage =
  'outlet' | 'noHousehold' | 'handoff' | 'handoffHousehold'

export function shellPage(
  pathname: string,
  tv: boolean,
  homeless: boolean,
): ShellPage {
  if (homeless && !HOMELESS.includes(pathname))
    return tv ? 'handoffHousehold' : 'noHousehold'
  return tv && tvRoute(pathname) === 'handoff' ? 'handoff' : 'outlet'
}

/** The handoff page's Back with no history: `/`, unless `/` would be the
 * handoff page itself (TV mode, no household). */
export const handoffHome = (tv: boolean, homeless: boolean) =>
  shellPage('/', tv, homeless) === 'outlet' ? '/' : '/settings'
