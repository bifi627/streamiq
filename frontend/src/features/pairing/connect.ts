// Connect to a gateway through the tenant broker, enforce the pin, prove this
// browser's client key, and (when pairing) run commit/reveal for the
// comparison code. docs/protocol.md, "Broker" + "Pairing".
import { auth } from '../../shared/firebase'
import { API } from '../../shared/api'
import { diag, event, pcState, relayOn, relayTlsOn } from '../../shared/diag'
import {
  authMessage,
  b64,
  comparisonCode,
  hex,
  nonce,
  sdpFingerprint,
  sha256,
  verifyProof,
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
import { relayLine } from './relay'
import { AppError } from '../../shared/errors'
import type { BrowserMessage } from '../../generated/protocol'
import type { ClientAuthMessage } from '../../generated/sessions'
import {
  atOnce,
  ICE_FAILED_GRACE_MS,
  start,
  step,
  type Effect,
  type Event,
} from './handshake'

export type { Session }

// The key signs both certificate fingerprints and the gateway's nonce. No local
// description = an SDP without a fingerprint, which throws.
async function challengeAnswer(
  theirNonce: string,
  key: ClientKey,
  gatewayDtlsFp: string,
  sdp = '',
) {
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    authMessage(gatewayDtlsFp, sdpFingerprint(sdp), theirNonce),
  )
  return { spki: b64(key.spki), sig: b64(sig) }
}

/** The user's answer to "Does the gateway show this code?" */
export type Confirm = (matches: boolean) => void

/**
 * Resolves once the gateway lets this browser use the tunnel. With onCode set, an
 * unpaired browser starts pairing and onCode receives the code to compare; a
 * pairing resolves only once the gateway approved and confirm(true) was called.
 * An aborted signal closes the attempt: the gateway frees its pairing slot.
 * direct: ignore a forced relay (a gateway whose relay is off).
 */
export async function connect(
  gatewayId: string,
  onCode?: (code: string, confirm: Confirm) => void,
  signal?: AbortSignal,
  direct = false,
): Promise<Session> {
  const force = !direct && relayOn()
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
    iceTransportPolicy: force ? 'relay' : 'all',
  })
  // addEventListener: the handlers below own the on* properties.
  pc.addEventListener('connectionstatechange', () => pcState(pc))
  pc.addEventListener('iceconnectionstatechange', () => pcState(pc))
  const { close, keepAlive, up } = lifetime(pc, ws, gatewayId)
  const send = (m: BrowserMessage) => ws.send(JSON.stringify(m))

  return new Promise<Session>((resolve, reject) => {
    const ch = pc.createDataChannel('auth')
    const say = (m: ClientAuthMessage) => ch.send(JSON.stringify(m))
    let nB = '' // this browser's pairing nonce, revealed after the commit
    let grace: ReturnType<typeof setTimeout> | undefined
    signal?.addEventListener(
      'abort',
      () => {
        close()
        reject(new AppError('unknown', 'connect aborted'))
      },
      { once: true },
    )

    const run = async (f: Effect) => {
      switch (f.do) {
        case 'auth':
          send({ type: 'auth', token: token ?? '', gatewayId }) // signed out: the broker refuses it
          return keepAlive(send)
        case 'relayLine':
          diag.relay = relayLine(f.noTurn)
          return
        case 'offer':
          pc.setConfiguration({
            ...pc.getConfiguration(),
            iceServers: f.iceServers,
          })
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          return send({
            type: 'offer',
            gatewayId,
            sdp: pc.localDescription ?? offer,
          })
        case 'answer':
          return pc.setRemoteDescription(f.sdp)
        case 'addIce':
          return pc.addIceCandidate(f.candidate)
        case 'verify': {
          const ours = sdpFingerprint(pc.localDescription?.sdp ?? '')
          const keyFp = await verifyProof(f.spki, f.sig, f.dtlsFp, ours, f.n)
          return dispatch({ on: 'proof', n: f.n, keyFp })
        }
        case 'sign': {
          const sdp = pc.localDescription?.sdp
          const answer = await challengeAnswer(f.n, key, f.dtlsFp, sdp)
          return say({ type: 'auth', ...answer, pair: f.pair })
        }
        case 'commit':
          nB = nonce()
          return say({
            type: 'commit',
            h: hex(await sha256(nB)),
            name: browserName(),
          })
        case 'reveal': {
          say({ type: 'reveal', n: nB })
          const code = await comparisonCode(f.fp, key.fp, f.n, nB)
          // A connect that failed during the digest shows no code.
          return s.phase === 'failed'
            ? undefined
            : onCode?.(code, (ok) => dispatch({ on: 'match', ok }))
        }
        case 'approved':
          await setPin(gatewayId, f.fp)
          void persistStorage().catch((e) =>
            event(`storage: persist failed: ${e}`),
          )
          shared.drop(gatewayId) // its session belongs to the old identity
          return resolve(up())
        case 'resolve':
          return resolve(up())
        case 'grace':
          clearTimeout(grace)
          if (f.arm)
            grace = setTimeout(
              () => dispatch({ on: 'graceOver' }),
              ICE_FAILED_GRACE_MS,
            )
          return
        case 'fail':
          clearTimeout(grace)
          close()
          return reject(f.error)
      }
    }

    let s = start({
      gatewayId,
      pin,
      pairing: !!onCode,
      forceRelay: force,
      relayTls: force && relayTlsOn(),
    })
    let queue = Promise.resolve()
    function dispatch(ev: Event) {
      const r = step(s, ev)
      s = r.state
      for (const f of r.fx) {
        if (atOnce(f)) void run(f)
        else
          queue = queue
            .then(() => run(f))
            .catch((error) => dispatch({ on: 'error', error }))
      }
    }

    ws.onopen = () => dispatch({ on: 'open' })
    ws.onclose = (e) => dispatch({ on: 'close', reason: e.reason })
    ws.onmessage = (e) => dispatch({ on: 'broker', data: e.data })
    pc.onconnectionstatechange = () =>
      dispatch({ on: 'connection', state: pc.connectionState })
    pc.onicecandidate = (e) =>
      e.candidate && send({ type: 'ice', candidate: e.candidate.toJSON() })
    ch.onclose = () => dispatch({ on: 'channelClose' })
    ch.onmessage = (e) => dispatch({ on: 'gateway', data: e.data })
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
