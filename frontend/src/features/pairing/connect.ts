// Connect to a gateway through the tenant broker, enforce the pin, prove this
// browser's client key, and (when pairing) run commit/reveal for the
// comparison code. docs/protocol.md, "Broker" + "Pairing".
import { auth } from '../../firebase'
import { API, authed } from '../../api'
import { pairInfo } from '../../stats'
import { pcState, relayOn } from '../../diag'
import { measure, type Speed } from '../../speed'
import {
  authMessage,
  b64,
  comparisonCode,
  hex,
  nonce,
  pinCheck,
  sdpFingerprint,
  sha256,
} from './crypto'
import { clientKey, getPin, persistStorage, setPin } from './store'
import { sharer } from './shared'
import {
  AppError,
  brokerClosed,
  brokerError,
  toAppError,
  type Kind,
} from '../../errors'

export type Session = {
  pc: RTCPeerConnection
  close: () => void
  /** gateway → client throughput (#162): starts the measurement on the first
   * call, once per session, so sessions that never stream cost no bursts. */
  speed: () => Speed
}

type Msg = Record<string, string | undefined> & { type: string }

/**
 * Resolves once the gateway lets this browser use the tunnel. With onCode set, an
 * unpaired browser starts pairing and onCode receives the code to compare.
 */
export async function connect(
  gatewayId: string,
  onCode?: (code: string) => void,
): Promise<Session> {
  const [key, pin, token] = await Promise.all([
    clientKey(),
    getPin(gatewayId),
    auth.currentUser?.getIdToken(),
  ])
  const ws = new WebSocket(API.replace(/^http/, 'ws') + '/broker/ws')
  // ICE servers arrive with the broker's `ready`: this session's own TURN
  // credential, revoked when the session ends.
  const pc = new RTCPeerConnection({
    // Diagnostic: `?relay` or the diagnostics panel's toggle forces the TURN path.
    iceTransportPolicy: relayOn() ? 'relay' : 'all',
  })
  // addEventListener: the handlers below own the on* properties.
  pc.addEventListener('connectionstatechange', () => pcState(pc))
  pc.addEventListener('iceconnectionstatechange', () => pcState(pc))
  // Connection telemetry: one row per attempt. A tunnel that came up gets its
  // ICE pair now and totals on close; a failed one gets its reason. ponytail: a
  // closed tab skips the end PATCH (row keeps EndedAt null), and so does a tab
  // closed mid-connect (no row at all).
  let logged: Promise<string | null> | null = null
  let settled = false
  let speed: Speed | undefined
  let ping: ReturnType<typeof setInterval> | undefined
  const teardown = () => {
    clearInterval(ping)
    pc.close()
    ws.close() // the broker tells the gateway `bye`
  }
  const close = () => {
    speed?.stop()
    const row = logged
    logged = null
    if (!row) return teardown()
    void Promise.all([row, pc.getStats()])
      .then(([id, s]) => {
        const p = pairInfo(s)
        if (id && p)
          return authed(`/connections/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              bytesReceived: p.bytesReceived,
              bytesSent: p.bytesSent,
              throughputKbps: kbps(speed?.fresh()),
            }),
          })
      })
      .catch(() => {})
      .finally(teardown)
  }
  const up = (): Session => {
    settled = true
    logged = pc
      .getStats()
      .then((s) => {
        const p = pairInfo(s)
        if (!p) return null
        return authed<{ id: string }>('/connections', {
          method: 'POST',
          body: JSON.stringify({
            gatewayId,
            relay: p.relay,
            ipv6: p.ipv6,
            localCandidateType: p.local,
            remoteCandidateType: p.remote,
            protocol: p.protocol,
          }),
        }).then((r) => r.id)
      })
      .catch(() => null)
    return { pc, close, speed: () => (speed ??= measure(pc, gatewayId)) }
  }
  const send = (m: object) => ws.send(JSON.stringify(m))

  return new Promise<Session>((resolve, reject) => {
    const err = (kind: Kind, detail: string) =>
      new AppError(kind, detail, { gatewayId })
    const fail = (x: unknown) => {
      const e = toAppError(x)
      if (!settled) {
        settled = true
        void authed('/connections', {
          method: 'POST',
          body: JSON.stringify({
            gatewayId,
            failure: e.kind === 'pin-mismatch' ? 'pin mismatch' : e.message,
          }),
        }).catch(() => {})
      }
      close()
      reject(e)
    }
    let gatewayFp = ''
    let verdict: ReturnType<typeof pinCheck> = 'refuse'
    let nB = ''

    let opened = false
    ws.onopen = () => {
      opened = true
      send({ type: 'auth', token })
      // The socket lives as long as the session, often idle (a screen waiting,
      // #180); a proxy (Railway edge, Cloudflare tunnel) may drop a quiet one,
      // and that ends the tunnel too. The broker ignores the ping.
      ping = setInterval(() => send({ type: 'ping' }), 25_000)
    }
    ws.onclose = () => fail(brokerClosed(opened, { gatewayId }))
    // Handle broker messages strictly in order. The gateway can still trickle a
    // candidate before its answer (Pion gathers during SetLocalDescription), so
    // candidates that beat the answer wait in `early`.
    let queue = Promise.resolve()
    const early: RTCIceCandidateInit[] = []
    ws.onmessage = (e) => {
      queue = queue.then(() => onBroker(JSON.parse(e.data))).catch(fail)
    }
    const onBroker = async (m: { type: string; [k: string]: any }) => {
      if (m.type === 'ready') {
        pc.setConfiguration({
          ...pc.getConfiguration(),
          iceServers: m.iceServers,
        })
        await pc.setLocalDescription(await pc.createOffer())
        send({ type: 'offer', gatewayId, sdp: pc.localDescription })
      } else if (m.type === 'answer') {
        gatewayFp = sdpFingerprint(m.sdp.sdp)
        // Before a single byte goes to the gateway: an unexpected certificate means
        // someone (possibly StreamIQ's own server) is in the middle. Pairing again is
        // allowed: the comparison code authenticates the new certificate.
        verdict = pinCheck(pin, gatewayFp, !!onCode)
        if (verdict === 'refuse')
          return fail(
            err(
              'pin-mismatch',
              `gateway certificate changed: pinned ${pin}, got ${gatewayFp}`,
            ),
          )
        await pc.setRemoteDescription(m.sdp)
        for (const c of early.splice(0)) await pc.addIceCandidate(c)
      } else if (m.type === 'ice') {
        if (pc.remoteDescription) await pc.addIceCandidate(m.candidate)
        else early.push(m.candidate)
      } else if (m.type === 'error') {
        fail(brokerError(m.error, { gatewayId }))
      }
    }
    pc.onconnectionstatechange = () =>
      pc.connectionState === 'failed' &&
      fail(
        err(
          'ice-failed',
          'ICE failed: no direct or relayed route to the gateway',
        ),
      )
    pc.onicecandidate = (e) =>
      e.candidate && send({ type: 'ice', candidate: e.candidate.toJSON() })

    const ch = pc.createDataChannel('auth')
    const say = (m: object) => ch.send(JSON.stringify(m))
    ch.onclose = () =>
      fail(err('gateway-refused', 'gateway closed the connection'))
    ch.onmessage = (e) => onGateway(JSON.parse(e.data)).catch(fail)
    const onGateway = async (m: Msg) => {
      switch (m.type) {
        case 'challenge': {
          const browserFp = sdpFingerprint(pc.localDescription!.sdp)
          const sig = await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            key.privateKey,
            authMessage(gatewayFp, browserFp, m.n!),
          )
          // No matching pin (new browser, or the gateway's cert changed): ask for
          // the code comparison even if the gateway knows our key — "ok" alone
          // can't vouch for a certificate we haven't verified.
          return say({
            type: 'auth',
            spki: b64(key.spki),
            sig: b64(sig),
            pair: verdict !== 'pinned',
          })
        }
        case 'ok':
          if (verdict !== 'pinned')
            return fail(
              err(
                'pin-mismatch',
                'gateway skipped pairing for an unpinned certificate',
              ),
            )
          ch.onclose = null
          return resolve(up())
        case 'unpaired':
          if (!onCode)
            return fail(
              err('not-paired', 'this browser is not paired with the gateway'),
            )
          nB = nonce()
          return say({
            type: 'commit',
            h: hex(await sha256(nB)),
            name: browserName(),
          })
        case 'nonce':
          say({ type: 'reveal', n: nB })
          return onCode?.(await comparisonCode(gatewayFp, key.fp, m.n!, nB))
        case 'approved':
          await setPin(gatewayId, gatewayFp)
          void persistStorage().catch(() => {}) // best effort, logged to diag
          shared.drop(gatewayId) // its session belongs to the old certificate
          ch.onclose = null
          return resolve(up())
        case 'rejected':
          return fail(
            err(
              'gateway-refused',
              `gateway refused: ${m.reason ?? 'rejected'}`,
            ),
          )
      }
    }
  })
}

/** The library and the gateway details share one session per gateway (#152);
 * Diagnostics and Pairing call connect() for a fresh one. */
const shared = sharer((id) => connect(id), relayOn)
export const share = shared.share

const kbps = (mbps?: number) => (mbps ? Math.round(mbps * 1000) : null)

function browserName() {
  const ua = navigator.userAgent
  const b = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser'
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  return os ? `${b} on ${os}` : b
}
