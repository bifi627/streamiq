// TV mode decides per route, not per element: a route not listed here is
// TV-off until it's added (a new manage page can't leak onto the TV).
export type TvRoute = 'allow' | 'handoff'

const ALLOWED = ['/settings', '/diagnostics', '/gateways']

export function tvRoute(pathname: string): TvRoute {
  const p = pathname.replace(/\/+$/, '') || '/'
  return p === '/' || p === '/g' || p.startsWith('/g/') || ALLOWED.includes(p)
    ? 'allow'
    : 'handoff'
}

/** What the shell shows in place of the route. `handoff`: the current URL;
 * `handoffHousehold`: /household's URL (TV mode, no household). */
export type ShellPage =
  'outlet' | 'noHousehold' | 'handoff' | 'handoffHousehold'

export function shellPage(
  pathname: string,
  tv: boolean,
  homeless: boolean,
): ShellPage {
  if (tv && tvRoute(pathname) === 'handoff')
    return homeless ? 'handoffHousehold' : 'handoff'
  // In no household only Settings and /join (the way in) still open.
  if (homeless && pathname !== '/settings' && pathname !== '/join')
    return tv ? 'handoffHousehold' : 'noHousehold'
  return 'outlet'
}
