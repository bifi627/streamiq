// The shell badge's connection type. No imports, so node --test runs it.

export type Route = 'lan' | 'direct' | 'relay' | 'forced' | 'forcedTls'

/** How a tunnel was opened: Force relay off, on, or on over TLS only. */
export type Forced = 'no' | 'yes' | 'tls'

/** A gateway's connection type as last seen this page load: the shell's
 * one check or the library's live tunnel. mb: relayed so far, live only. */
export type Conn = {
  route: Route | 'failed' | 'unpaired' | 'reconnecting'
  mb?: number
}

export const connKey = (gatewayId: string) => ['connection', gatewayId]

/** forced: how the tunnel was opened, not the flag now (a forced tunnel
 * stays forced after the toggle goes off; a gateway whose relay is off ignores it). */
export const routeOf = (
  relay: boolean,
  lan: boolean,
  forced: Forced = 'no',
): Route =>
  !relay
    ? lan
      ? 'lan'
      : 'direct'
    : ({ no: 'relay', yes: 'forced', tls: 'forcedTls' } as const)[forced]

/** What follows the gateway's dot: nothing unless it is online, then
 * "Checking…" until a check or the library's tunnel answers. */
export const connPart = (dot: string, conn?: Conn) =>
  dot !== 'online' ? null : (conn?.route ?? 'checking')

export const isRoute = (part: ReturnType<typeof connPart>): part is Route =>
  part === 'lan' ||
  part === 'direct' ||
  part === 'relay' ||
  part === 'forced' ||
  part === 'forcedTls'

/** What the shell badge names: the gateway only when its household
 * has more than one, the household's initial only when the user is in more
 * than one; the popover always names both. */
export const badgeNames = (
  gateway: string,
  gateways: number,
  household: string,
  households: number,
) => ({
  name: gateways > 1 ? gateway : null,
  initial: households > 1 ? ([...household][0] ?? '').toUpperCase() : null,
  heading: household ? `${gateway} in ${household}` : gateway, // before /me
})
