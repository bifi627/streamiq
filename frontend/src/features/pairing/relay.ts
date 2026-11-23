// A broker that couldn't issue a TURN credential sends STUN only, and a
// forced relay (or a network that needs one) then fails like a network problem.

const NO_TURN = 'no TURN server from the broker'
const NO_TLS_TURN = 'no TURN server on TLS 443 from the broker'
/** `ready` said the gateway's relay is off. */
export const DIRECT_ONLY = 'this gateway allows direct connections only'

/** The broker's `ready` iceServers include a TURN server (turn: or turns:). */
export function hasTurn(servers: RTCIceServer[] | undefined): boolean {
  return (servers ?? []).some((s) =>
    [s.urls].flat().some((u) => /^turns?:/i.test(u)),
  )
}

/** "Force relay over TLS (443)": keep only the `turns:…:443` URLs, so a
 * test proves the TLS relay a 443-only network needs (Cloudflare also hands out
 * turns: on 5349, which such a network blocks). None → no servers: no fallback. */
export function tlsOnly(servers: RTCIceServer[]): RTCIceServer[] {
  return servers.flatMap((s) => {
    const urls = [s.urls]
      .flat()
      .filter((u) => /^turns:[^?]*:443(\?|$)/i.test(u))
    return urls.length ? [{ ...s, urls }] : []
  })
}

/** The ICE servers this session uses, and why it has no relay ('' = it has one). */
export function relayServers(
  servers: RTCIceServer[] | undefined,
  tls: boolean,
  relayOff = false,
) {
  const iceServers = tls ? tlsOnly(servers ?? []) : (servers ?? [])
  const noTurn = relayOff
    ? DIRECT_ONLY
    : hasTurn(iceServers)
      ? ''
      : tls
        ? NO_TLS_TURN
        : NO_TURN
  return { iceServers, noTurn }
}

/** The diagnostics report line for a session's relay. */
export const relayLine = (noTurn: string) =>
  `relay: ${noTurn === DIRECT_ONLY ? `off (${noTurn})` : noTurn ? `unavailable (${noTurn})` : 'available'}`
