export type Tab = 'gateways' | 'activity' | 'library' | 'household' | 'settings'

/** The nav's tabs, in order. TV mode: Library and Settings only; in no
 * household only the pages that still open (tvRoute.ts shellPage). */
export function tabs(tv: boolean, homeless: boolean): Tab[] {
  if (homeless) return tv ? ['settings'] : ['household', 'settings']
  return tv
    ? ['library', 'settings']
    : ['gateways', 'activity', 'library', 'household', 'settings']
}

/** The Library tab's gateway: the open one, else the last opened on this
 * device (if still listed), else the only one; null = the tab is disabled. */
export function libraryTarget(
  open: string | undefined,
  last: string | null,
  ids: string[],
): string | null {
  if (open) return open
  if (last && ids.includes(last)) return last
  return ids.length === 1 ? ids[0] : null
}

/** The player is full screen: no top bar, title row or tab bar. */
export const chromeless = (pathname: string) => pathname.includes('/play/')

/** TV mode's Use as screen in the top bar: the active gateway (the badge's),
 * none while its screen page is shown. */
export const screenTarget = (
  tv: boolean,
  active: string | null,
  pathname: string,
) => (tv && active && !pathname.endsWith('/screen') ? active : null)
