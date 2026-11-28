// The /diagnostics report (DiagnosticsPage.tsx wires it): plain lines, no
// email, no IPs.

export type Test = { lines: string[]; failed?: string }

/** The gateway the test starts on: the first online one, else the first. */
export const defaultGateway = (gateways: { id: string; online: boolean }[]) =>
  (gateways.find((g) => g.online) ?? gateways[0])?.id ?? ''

export const gatewayLabel = (
  g: { id: string; name: string | null; online: boolean } | undefined,
) => (g ? `${g.name ?? g.id}${g.online ? '' : ' (offline)'}` : 'none')

/** The report's `relay forced:` line; a gateway with its relay off skips it. */
export const relayForcedLine = (relayOff: boolean, forced: string) =>
  `relay forced: ${relayOff ? 'skipped (relay off for this gateway)' : forced}`

/** The throughput test's line; Auto caps at 70 % of it. */
export const throughputLine = (mbps: number, dataSaver: boolean) =>
  `throughput: ${mbps.toFixed(1)} Mbps (median of ${dataSaver ? '3 × 1 MiB bursts, data saver on' : '3 ~2 s bursts after a warm-up'}; Auto caps at ${(mbps * 0.7).toFixed(1)} Mbps)`

export function report(r: {
  browser: string
  screen: string
  caps: string
  cpu: string
  memory: string
  lastRun: string
  lastPlayback: string | null
  test: Test | null
  gatewayId: string
  gw?: { name: string | null; version: string | null }
}) {
  return [
    'StreamIQ diagnostics',
    `browser: ${r.browser}`,
    `screen: ${r.screen}`,
    `codecs: ${r.caps}`,
    ...(r.cpu ? [`cpu: ${r.cpu}`] : []),
    ...(r.memory ? [`memory: ${r.memory}`] : []),
    ...(r.lastRun ? [r.lastRun] : []),
    `last playback: ${r.lastPlayback ?? 'none'}`,
    ...(r.test
      ? [
          `gateway: ${r.gw?.name ?? r.gatewayId} (${r.gw?.version ?? '?'})`,
          ...r.test.lines,
          ...(r.test.failed ? [r.test.failed] : []),
        ]
      : ['connection test: not run']),
  ].join('\n')
}
