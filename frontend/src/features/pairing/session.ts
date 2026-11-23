// A tunnel's lifetime on this browser: the broker keep-alive, the throughput
// report on close, and the Session handle connect() resolves with.
import { tunnelFetch } from '../../shared/tunnel'
import { measure, type Speed } from '../../shared/speed'
import { event } from '../../shared/diag'
import type { Ping } from '../../generated/protocol'
import type { Throughput } from '../../generated/tunnel'

export type Session = {
  pc: RTCPeerConnection
  close: () => void
  /** close() ran (the pc closes a moment later, after the throughput report). */
  closed: boolean
  /** gateway → client throughput: measures only when Auto playback or
   * /diagnostics asks (speed.ts). */
  speed: () => Speed
}

export function lifetime(
  pc: RTCPeerConnection,
  ws: WebSocket,
  gatewayId: string,
) {
  // Tunnel history: the gateway records the tunnel; this browser only adds the
  // throughput it measured, over the tunnel itself, before it closes.
  // ponytail: a closed tab skips that report (the line keeps no throughput).
  let speed: Speed | undefined
  let ping: ReturnType<typeof setInterval> | undefined
  const teardown = () => {
    clearInterval(ping)
    pc.close()
    ws.close() // the broker tells the gateway `bye`
  }
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    speed?.stop()
    const throughputKbps = kbps(speed?.fresh())
    if (!throughputKbps || pc.connectionState !== 'connected') return teardown()
    // A tunnel dying under the report may never answer it: the close waits REPORT_MS
    // at most, or the broker socket (TURN credential, tunnel end) would stay open.
    void Promise.race([
      tunnelFetch(pc, '/streamiq/tunnels/throughput', {
        method: 'POST',
        body: JSON.stringify({ throughputKbps } satisfies Throughput),
      }),
      new Promise((_, timedOut) =>
        setTimeout(() => timedOut(new Error('no answer')), REPORT_MS),
      ),
    ])
      .catch((e) => event(`tunnel: throughput report failed: ${e}`))
      .finally(teardown)
  }
  return {
    close,
    // The socket lives as long as the session, often idle (a screen
    // waiting); a proxy (Railway edge, Cloudflare tunnel) may drop a quiet one,
    // and that ends the tunnel too. The broker ignores the ping.
    keepAlive: (send: (m: Ping) => void) => {
      ping = setInterval(() => send({ type: 'ping' }), 25_000)
    },
    up: (): Session => ({
      pc,
      close,
      get closed() {
        return closed
      },
      speed: () => (speed ??= measure(pc, gatewayId)),
    }),
  }
}

const REPORT_MS = 2000

const kbps = (mbps?: number) => (mbps ? Math.round(mbps * 1000) : null)
