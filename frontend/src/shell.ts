export type Tab = 'gateways' | 'library' | 'photos' | 'household' | 'settings'

/** Where a tab leads (Library, Photos: the active gateway's, Nav.tsx). */
export const TAB_TO = {
  gateways: '/gateways',
  household: '/settings/households',
  settings: '/settings',
} as const

/** The nav's tabs, Library in the middle, Photos after it while the active
 * gateway has a photo library. TV: no Gateways; in no household, Household
 * is the way back to the no-household screen. */
export function tabs(tv: boolean, homeless: boolean, photos = false): Tab[] {
  if (homeless) return tv ? ['settings'] : ['household', 'settings']
  const media: Tab[] = photos ? ['library', 'photos'] : ['library']
  return tv ? [...media, 'settings'] : ['gateways', ...media, 'settings']
}

/** The active gateway (the Library tab's, the badge's, Use as screen's): the
 * open one, else the last opened on this device (if still listed), else the
 * first online, else the first; null only without a gateway. */
export function libraryTarget(
  open: string | undefined,
  last: string | null,
  gateways: { id: string; online: boolean }[],
): string | null {
  if (open) return open
  if (last && gateways.some((g) => g.id === last)) return last
  return (gateways.find((g) => g.online) ?? gateways[0])?.id ?? null
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
