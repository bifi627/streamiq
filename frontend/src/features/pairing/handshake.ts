// The connect handshake's decisions: connect.ts feeds the broker socket,
// connection state and data channel events into step() and carries out the effects.
// docs/protocol.md, "Broker" + "Pairing".
import {
  AppError,
  brokerClosed,
  brokerError,
  toAppError,
  type Kind,
} from '../../errors.ts'
import { answerCheck } from './crypto.ts'
import { relayServers } from './relay.ts'
import type { BrokerMessage } from '../../generated/protocol.ts'
import type { GatewayAuthMessage } from '../../generated/sessions.ts'

// quirk(#632): while connecting, Chrome reports 'failed' once every candidate
// pair so far failed, and 'connecting' again on the gateway's next candidate.
// So a 'failed' before 'connected' ends the connect only once it has lasted
// this long; after a 'connected' it is a lost tunnel and ends it at once, so
// the next request sees a closed pc, not a data channel that never opens.
export const ICE_FAILED_GRACE_MS = 5000

export type Init = {
  gatewayId: string
  pin: string | undefined
  /** An unpaired browser may start pairing (connect() got onCode). */
  pairing: boolean
  forceRelay: boolean
  relayTls: boolean
}

export type State = Init & {
  phase: 'connecting' | 'up' | 'failed'
  opened: boolean
  gatewayFp: string
  verdict: 'pinned' | 'unpinned' | 'refuse'
  noTurn: string // why there's no relay, once `ready` says so
  answered: boolean
  // The gateway can trickle a candidate before its answer (Pion gathers during
  // SetLocalDescription): those wait here for the remote description.
  early: RTCIceCandidateInit[]
  iceUp: boolean
  grace: boolean
  // Pairing runs unpaired → commit → nonce → reveal → approved, each once:
  // anything out of that order is refused.
  paired: 'no' | 'committed' | 'revealed'
}

export type Event =
  | { on: 'open' }
  | { on: 'close'; reason: string }
  | { on: 'broker'; data: string }
  | { on: 'gateway'; data: string }
  | { on: 'channelClose' }
  | { on: 'connection'; state: RTCPeerConnectionState }
  | { on: 'graceOver' }
  | { on: 'error'; error: unknown }

export type Effect =
  | { do: 'auth' } // the token, then the keep-alive
  | { do: 'relayLine'; noTurn: string }
  | { do: 'offer'; iceServers: RTCIceServer[] }
  | { do: 'answer'; tunnel?: string; sdp: RTCSessionDescriptionInit }
  | { do: 'addIce'; candidate: RTCIceCandidateInit }
  | { do: 'challenge'; n: string; fp: string; pair: boolean }
  | { do: 'commit' }
  | { do: 'reveal'; n: string; fp: string }
  | { do: 'approved'; fp: string } // pin it, then resolve
  | { do: 'resolve' }
  | { do: 'grace'; arm: boolean }
  | { do: 'fail'; error: AppError }

type Step = { state: State; fx: Effect[] }

/** These run when they're emitted; the rest run one after another, in order. */
export const atOnce = (f: Effect) => f.do === 'fail' || f.do === 'grace'

export const start = (init: Init): State => ({
  ...init,
  phase: 'connecting',
  opened: false,
  gatewayFp: '',
  verdict: 'refuse',
  noTurn: '',
  answered: false,
  early: [],
  iceUp: false,
  grace: false,
  paired: 'no',
})

export function step(s: State, ev: Event): Step {
  if (s.phase === 'failed') return same(s)
  try {
    return onEvent(s, ev)
  } catch (e) {
    return failed(s, toAppError(e))
  }
}

function onEvent(s: State, ev: Event): Step {
  switch (ev.on) {
    case 'open':
      return { state: { ...s, opened: true }, fx: [{ do: 'auth' }] }
    case 'close':
      return failed(
        s,
        brokerClosed(s.opened, { gatewayId: s.gatewayId }, ev.reason),
      )
    case 'broker':
      return onBroker(s, JSON.parse(ev.data))
    case 'gateway':
      return onGateway(s, JSON.parse(ev.data))
    case 'channelClose':
      return s.phase === 'up'
        ? same(s)
        : fail(s, 'gateway-refused', 'gateway closed the connection')
    case 'connection':
      return onConnection(s, ev.state)
    case 'graceOver':
      return s.grace ? iceFailed(s) : same(s)
    case 'error':
      return failed(s, toAppError(ev.error))
  }
}

function onBroker(s: State, m: BrokerMessage): Step {
  switch (m.type) {
    case 'ready': {
      const { iceServers, noTurn } = relayServers(m.iceServers, s.relayTls)
      const next = { ...s, noTurn }
      const line: Effect = { do: 'relayLine', noTurn }
      // A forced relay without a TURN server can't connect: say why now.
      if (noTurn && s.forceRelay) {
        const r = fail(
          next,
          'ice-failed',
          `relay forced, but relay unavailable: ${noTurn}`,
        )
        return { state: r.state, fx: [line, ...r.fx] }
      }
      return { state: next, fx: [line, { do: 'offer', iceServers }] }
    }
    case 'answer': {
      // Before a single byte goes to the gateway (pairing again is allowed).
      const a = answerCheck(m.sdp.sdp ?? '', s.pin, s.pairing)
      if ('refused' in a) return fail(s, 'pin-mismatch', a.refused)
      const state = {
        ...s,
        gatewayFp: a.fp,
        verdict: a.verdict,
        answered: true,
        early: [],
      }
      const ice = s.early.map((candidate): Effect => ({
        do: 'addIce',
        candidate,
      }))
      return {
        state,
        fx: [{ do: 'answer', tunnel: m.tunnel, sdp: m.sdp }, ...ice],
      }
    }
    case 'ice':
      return s.answered
        ? { state: s, fx: [{ do: 'addIce', candidate: m.candidate }] }
        : { state: { ...s, early: [...s.early, m.candidate] }, fx: [] }
    case 'error':
      return failed(s, brokerError(m.error, { gatewayId: s.gatewayId }))
  }
  return same(s)
}

function onGateway(s: State, m: GatewayAuthMessage): Step {
  switch (m.type) {
    case 'challenge':
      // No matching pin (new browser, or the gateway's cert changed): ask for
      // the code comparison even if the gateway knows our key — "ok" alone
      // can't vouch for a certificate we haven't verified.
      return withNonce(s, m, (n) => ({
        do: 'challenge',
        n,
        fp: s.gatewayFp,
        pair: s.verdict !== 'pinned',
      }))
    case 'ok':
      return s.verdict === 'pinned'
        ? { state: { ...s, phase: 'up' }, fx: [{ do: 'resolve' }] }
        : fail(
            s,
            'pin-mismatch',
            'gateway skipped pairing for an unpinned certificate',
          )
    case 'unpaired':
      if (!s.pairing)
        return fail(
          s,
          'not-paired',
          'this browser is not paired with the gateway',
        )
      return s.paired === 'no'
        ? { state: { ...s, paired: 'committed' }, fx: [{ do: 'commit' }] }
        : outOfOrder(s, m)
    case 'nonce':
      if (s.paired !== 'committed') return outOfOrder(s, m)
      return withNonce({ ...s, paired: 'revealed' }, m, (n) => ({
        do: 'reveal',
        n,
        fp: s.gatewayFp,
      }))
    case 'approved':
      if (s.paired !== 'revealed') return outOfOrder(s, m)
      return {
        state: { ...s, phase: 'up' },
        fx: [{ do: 'approved', fp: s.gatewayFp }],
      }
    case 'rejected':
      return fail(
        s,
        'gateway-refused',
        `gateway refused: ${m.reason ?? 'rejected'}`,
      )
  }
  return same(s)
}

const outOfOrder = (s: State, m: GatewayAuthMessage) =>
  fail(s, 'gateway-refused', `gateway's ${m.type} out of order`)

// The gateway's challenge and nonce messages carry one: without it, it's refused.
function withNonce(
  s: State,
  m: { type: string; n: string },
  fx: (n: string) => Effect,
): Step {
  if (!m.n)
    return fail(s, 'gateway-refused', `gateway's ${m.type} has no nonce`)
  return { state: s, fx: [fx(m.n)] }
}

function onConnection(s: State, pcState: RTCPeerConnectionState): Step {
  const iceUp = s.iceUp || pcState === 'connected'
  if (pcState === 'failed' && iceUp) return iceFailed(s)
  if (pcState === 'failed')
    return s.grace
      ? same(s)
      : { state: { ...s, grace: true }, fx: [{ do: 'grace', arm: true }] }
  const state = { ...s, iceUp, grace: false }
  return { state, fx: s.grace ? [{ do: 'grace', arm: false }] : [] }
}

const iceFailed = (s: State) =>
  fail(
    s,
    'ice-failed',
    `ICE failed: no direct or relayed route to the gateway${s.noTurn ? ` (relay unavailable: ${s.noTurn})` : ''}`,
  )

const same = (state: State): Step => ({ state, fx: [] })

const fail = (s: State, kind: Kind, detail: string) =>
  failed(s, new AppError(kind, detail, { gatewayId: s.gatewayId }))

const failed = (s: State, error: AppError): Step => ({
  state: { ...s, phase: 'failed' },
  fx: [{ do: 'fail', error }],
})
