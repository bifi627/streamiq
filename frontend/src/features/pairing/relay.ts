// #585: a broker that couldn't issue a TURN credential sends STUN only, and a
// forced relay (or a network that needs one) then fails like a network problem.

export const NO_TURN = 'relay unavailable: no TURN server from the broker'

/** The broker's `ready` iceServers include a TURN server (turn: or turns:). */
export function hasTurn(servers: RTCIceServer[] | undefined): boolean {
  return (servers ?? []).some((s) =>
    [s.urls].flat().some((u) => /^turns?:/i.test(u)),
  )
}

/** The diagnostics report line for a session's ICE servers. */
export const relayLine = (turn: boolean) =>
  `relay: ${turn ? 'available' : 'unavailable (no TURN server from the broker)'}`
