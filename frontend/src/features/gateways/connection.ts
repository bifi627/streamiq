// The shell badge's connection type. No imports, so node --test runs it.

export type Route = 'lan' | 'direct' | 'relay'

/** A gateway's connection type as last seen this page load: the shell's
 * one check or the library's live tunnel. mb: relayed so far, live only. */
export type Conn = { route: Route | 'failed' | 'unpaired'; mb?: number }

export const connKey = (gatewayId: string) => ['connection', gatewayId]

export const routeOf = (relay: boolean, lan: boolean): Route =>
  relay ? 'relay' : lan ? 'lan' : 'direct'

/** What follows the gateway's dot: nothing unless it is online, then
 * "Checking…" until a check or the library's tunnel answers. */
export const connPart = (dot: string, conn?: Conn) =>
  dot !== 'online' ? null : (conn?.route ?? 'checking')
