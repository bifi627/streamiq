// Connect to a gateway through the tenant broker, enforce the pin, prove this
// browser's client key, and (when pairing) run commit/reveal for the
// comparison code. docs/protocol.md, "Broker" + "Pairing".
import { auth } from '../../firebase'
import { API } from '../../api'
import { diag, event, pcState, relayOn, relayTlsOn } from '../../diag'
import {
  answerCheck,
  authMessage,
  b64,
  comparisonCode,
  hex,
  nonce,
  sdpFingerprint,
  sha256,
} from './crypto'
import { lifetime, type Session } from './session'
import {
  clientKey,
  getPin,
  persistStorage,
  setPin,
  type ClientKey,
} from './store'
import { sharer } from './shared'
import { relayLine, relayServers } from './relay'
import type { BrokerMessage, BrowserMessage } from '../../generated/protocol'
import { lastingFailure } from './iceFailed'
import {
  AppError,
  brokerClosed,
  brokerError,
  toAppError,
  type Kind,
} from '../../errors'

export type { Session }

type Msg = Record<string, string | undefined> & { type: string }

// The gateway's challenge and nonce messages carry one: without it, it's refused.
function theirNonce(m: Msg) {
  if (!m.n)
    throw new AppError('gateway-refused', `gateway's ${m.type} has no nonce`)
  return m.n
}

// The key signs both certificate fingerprints and the gateway's nonce. No local
// description = an SDP without a fingerprint, which throws.
async function challengeAnswer(
  m: Msg,
  key: ClientKey,
  gatewayFp: string,
  sdp = '',
) {
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    authMessage(gatewayFp, sdpFingerprint(sdp), theirNonce(m)),
  )
  return { spki: b64(key.spki), sig: b64(sig) }
}

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
    // Diagnostic: `?relay` or the diagnostics panel's toggle forces the TURN path;
    // `?relay=tls` or its TLS toggle keeps only the `turns:` servers.
    iceTransportPolicy: relayOn() ? 'relay' : 'all',
  })
  // addEventListener: the handlers below own the on* properties.
  pc.addEventListener('connectionstatechange', () => pcState(pc))
  pc.addEventListener('iceconnectionstatechange', () => pcState(pc))
  const { close, setTunnel, keepAlive, up } = lifetime(pc, ws, gatewayId)
  const send = (m: BrowserMessage) => ws.send(JSON.stringify(m))

  return new Promise<Session>((resolve, reject) => {
    const err = (kind: Kind, detail: string) =>
      new AppError(kind, detail, { gatewayId })
    const fail = (x: unknown) => {
      const e = toAppError(x)
      close()
      reject(e)
    }
    let gatewayFp = ''
    let verdict: 'pinned' | 'unpinned' | 'refuse' = 'refuse'
    let nB = ''
    let noTurn = '' // why there's no relay, once `ready` says so

    let opened = false
    ws.onopen = () => {
      opened = true
      send({ type: 'auth', token: token ?? '' }) // signed out: the broker refuses it
      keepAlive(send)
    }
    ws.onclose = (e) => fail(brokerClosed(opened, { gatewayId }, e.reason))
    // Handle broker messages strictly in order. The gateway can still trickle a
    // candidate before its answer (Pion gathers during SetLocalDescription), so
    // candidates that beat the answer wait in `early`.
    let queue = Promise.resolve()
    const early: RTCIceCandidateInit[] = []
    ws.onmessage = (e) => {
      queue = queue.then(() => onBroker(JSON.parse(e.data))).catch(fail)
    }
    const onBroker = async (m: BrokerMessage) => {
      if (m.type === 'ready') {
        const { iceServers, noTurn: why } = relayServers(
          m.iceServers,
          relayTlsOn(),
        )
        noTurn = why
        diag.relay = relayLine(noTurn)
        // A forced relay without a TURN server can't connect: say why now.
        if (noTurn && relayOn())
          return fail(
            err('ice-failed', `relay forced, but relay unavailable: ${noTurn}`),
          )
        pc.setConfiguration({ ...pc.getConfiguration(), iceServers })
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        send({ type: 'offer', gatewayId, sdp: pc.localDescription ?? offer })
      } else if (m.type === 'answer') {
        setTunnel(m.tunnel)
        // Before a single byte goes to the gateway (pairing again is allowed).
        const a = answerCheck(m.sdp.sdp ?? '', pin, !!onCode)
        if ('refused' in a) return fail(err('pin-mismatch', a.refused))
        gatewayFp = a.fp
        verdict = a.verdict
        await pc.setRemoteDescription(m.sdp)
        for (const c of early.splice(0)) await pc.addIceCandidate(c)
      } else if (m.type === 'ice') {
        if (pc.remoteDescription) await pc.addIceCandidate(m.candidate)
        else early.push(m.candidate)
      } else if (m.type === 'error') {
        fail(brokerError(m.error, { gatewayId }))
      }
    }
    const iceState = lastingFailure(() =>
      fail(
        err(
          'ice-failed',
          `ICE failed: no direct or relayed route to the gateway${noTurn ? ` (relay unavailable: ${noTurn})` : ''}`,
        ),
      ),
    )
    pc.onconnectionstatechange = () => iceState(pc.connectionState)
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
          const sdp = pc.localDescription?.sdp
          // No matching pin (new browser, or the gateway's cert changed): ask for
          // the code comparison even if the gateway knows our key — "ok" alone
          // can't vouch for a certificate we haven't verified.
          return say({
            type: 'auth',
            ...(await challengeAnswer(m, key, gatewayFp, sdp)),
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
          return onCode?.(
            await comparisonCode(gatewayFp, key.fp, theirNonce(m), nB),
          )
        case 'approved':
          await setPin(gatewayId, gatewayFp)
          void persistStorage().catch((e) =>
            event(`storage: persist failed: ${e}`),
          )
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

/** The library and the gateway details share one session per gateway;
 * Diagnostics and Pairing call connect() for a fresh one. */
const shared = sharer(
  (id) => connect(id),
  () => `${relayOn()}/${relayTlsOn()}`,
)
export const share = shared.share
export const dropShared = shared.drop

/** The pairing name this browser sends (also its screen name). */
export function browserName() {
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
