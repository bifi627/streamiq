// A tunnel's lifetime on this browser: the broker keep-alive, the throughput
// report on close, and the Session handle connect() resolves with.
import { authed } from '../../api'
import { measure, type Speed } from '../../speed'
import { event } from '../../diag'
import type { Ping } from '../../generated/protocol'

export type Session = {
  pc: RTCPeerConnection
  close: () => void
  /** close() ran (the pc closes a moment later, after the throughput PATCH). */
  closed: boolean
  /** gateway → client throughput: starts the measurement on the first
   * call, once per session, so sessions that never stream cost no bursts. */
  speed: () => Speed
}

export function lifetime(
  pc: RTCPeerConnection,
  ws: WebSocket,
  gatewayId: string,
) {
  // Tunnel telemetry: the broker and the gateway record the tunnel; this
  // browser only adds the throughput it measured, to the tunnel id from the answer.
  // ponytail: a closed tab skips that PATCH (the row keeps no throughput).
  let tunnel: string | undefined
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
    if (!tunnel || !throughputKbps) return teardown()
    void authed(`/tunnels/${tunnel}`, {
      method: 'PATCH',
      body: JSON.stringify({ throughputKbps }),
    })
      .catch((e) => event(`tunnel: throughput report failed: ${e}`))
      .finally(teardown)
  }
  return {
    close,
    /** The tunnel id from the gateway's answer. */
    setTunnel: (id: string | undefined) => {
      tunnel = id
    },
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

const kbps = (mbps?: number) => (mbps ? Math.round(mbps * 1000) : null)
