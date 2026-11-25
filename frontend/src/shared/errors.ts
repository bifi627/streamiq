// The app's one error model. Producers (connect, api, tunnel) throw an
// AppError with a kind; views render it through describe() / <ErrorView>. The
// message is the technical detail (what diagnostics log); user text lives in
// describe(). Imports only generated constants, so node:test can drive it.

import {
  CloseGatewayGone,
  CloseGatewayRevoked,
  CloseNoHousehold,
  CloseRateLimited,
  CloseServerError,
  CloseUnauthorized,
  GatewayBusy,
  GatewayOffline,
} from '../generated/protocol.ts'

export type Kind =
  | 'broker-unreachable' // broker socket closed before it opened: offline or rate-limited (a 429 is invisible to JS)
  | 'broker-lost' // broker socket dropped after it opened, or the broker failed on its side ("server error")
  | 'no-household' // the broker refused: the user is in no household (anymore)
  | 'rate-limited' // the broker closed the socket: too many messages
  | 'gateway-offline'
  | 'gateway-removed' // the broker closed the session: its gateway was removed from the household
  | 'gateway-busy' // the gateway refused for now: too many unauthenticated connections, or its pairing slots are taken
  | 'ice-failed'
  | 'direct-only' // ICE failed to a gateway whose relay is off
  | 'not-paired'
  | 'pin-mismatch'
  | 'code-mismatch' // the user said the gateway shows a different comparison code
  | 'gateway-refused'
  | 'tunnel-lost' // a request on an established tunnel got no (full) response
  | 'media-server-down' // gateway answered 502/503: Jellyfin down or no token
  | 'invite-invalid' // invite link unknown, expired, used or revoked (API 404)
  | 'last-admin' // the change would leave the household without an admin (API 409)
  | 'admin-only' // API 403: every 403 the API sends is a member refused an admin-only action
  | 'unauthorized' // API 401, or the broker refused the token
  | 'http' // any other non-2xx
  | 'network' // fetch itself failed
  | 'playback' // player decode / hls.js errors (wording comes from the player)
  | 'unknown'

export type Context = { gatewayId?: string; status?: number }

export class AppError extends Error {
  kind: Kind
  context: Context
  constructor(kind: Kind, detail: string, context: Context = {}) {
    super(detail)
    this.name = 'AppError'
    this.kind = kind
    this.context = context
  }
}

export const isKind = (e: unknown, kind: Kind) =>
  e instanceof AppError && e.kind === kind

/** Anything thrown → AppError; foreign errors become `unknown`. */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e
  return new AppError('unknown', e instanceof Error ? e.message : String(e))
}

/** A non-2xx from the API or from a gateway over the tunnel. */
export function httpError(
  via: 'api' | 'tunnel',
  status: number,
  path: string,
  context: Context = {},
) {
  const detail = `${path} → HTTP ${status}`
  const kind: Kind =
    via === 'api' && status === 401
      ? 'unauthorized'
      : via === 'api' && status === 403
        ? 'admin-only'
        : via === 'tunnel' && (status === 502 || status === 503)
          ? 'media-server-down'
          : 'http'
  return new AppError(kind, detail, { ...context, status })
}

const closeKind = new Map<string, Kind>([
  [CloseGatewayGone, 'gateway-offline'],
  [CloseGatewayRevoked, 'gateway-removed'],
  [CloseUnauthorized, 'unauthorized'],
  [CloseServerError, 'broker-lost'],
  [CloseNoHousehold, 'no-household'],
  [CloseRateLimited, 'rate-limited'],
])

/** The broker socket closed, with the broker's reason (docs/protocol.md). Any
 * other reason: before open, offline or the upgrade was refused (a 429 rate
 * limit is invisible to JS); after, a drop ("auth first" / "auth timeout" too:
 * a retry can help). */
export const brokerClosed = (
  opened: boolean,
  context: Context = {},
  reason = '',
) => {
  const kind = closeKind.get(reason)
  return kind
    ? new AppError(kind, `broker closed: ${reason}`, context)
    : opened
      ? new AppError('broker-lost', 'broker connection closed', context)
      : new AppError('broker-unreachable', 'broker connection failed', context)
}

/** The broker's `{type:"error"}` text (docs/protocol.md). */
export const brokerError = (text: string, context: Context = {}) =>
  new AppError(
    text === GatewayOffline
      ? 'gateway-offline'
      : text === GatewayBusy
        ? 'gateway-busy'
        : 'unknown',
    text,
    context,
  )

/** Also the hint where an admin-only action is hidden from a member. */
export const ADMIN_ONLY = 'Only a household admin can do this.'

/** The rename form's text for a failed POST /streamiq/name. A 500 is
 * the gateway's own failure, e.g. it can't write its state dir. */
export const renameMessage = (e: AppError) =>
  e.context.status === 400
    ? 'Use 1–100 characters, no control characters.'
    : e.context.status === 404
      ? 'This gateway is too old to rename: update it.'
      : e.context.status === 500
        ? "The gateway couldn't save the name; see its log."
        : describe(e).message

/** A failed relay switch: a gateway from before it answers 404. */
export const relayMessage = (e: AppError) =>
  e.context.status === 404
    ? 'This gateway is too old for this setting: update it.'
    : describe(e).message

export type Action = 'retry' | 'pair' | 'gateways' | 'sign-in' | 'reload'

/** The one action <ErrorView> shows as its button; the rest are links. */
export const primaryAction = (actions: Action[]) =>
  (['retry', 'sign-in', 'reload'] as const).find((a) => actions.includes(a))

// Exhaustive: a new Kind doesn't compile until it's mapped here.
export function describe(e: AppError): {
  message: string
  actions: Action[]
  loud?: boolean
} {
  switch (e.kind) {
    case 'broker-unreachable':
      return {
        message:
          "Couldn't reach StreamIQ: too many attempts or offline. Try again in a minute.",
        actions: ['retry'],
      }
    case 'broker-lost':
      return {
        message: 'Lost the connection to StreamIQ.',
        actions: ['retry'],
      }
    case 'no-household':
      // A reload shows the no-household screen (create or join one).
      return {
        message: "You're not in a household (anymore).",
        actions: ['reload'],
      }
    case 'rate-limited':
      // The budget is per socket: a reload opens a fresh one.
      return {
        message: 'Too many requests on this connection.',
        actions: ['reload'],
      }
    case 'gateway-offline':
      return {
        message: 'The gateway is offline.',
        actions: ['retry', 'gateways'],
      }
    case 'gateway-removed':
      return {
        message: 'This gateway was removed.',
        actions: ['gateways'],
      }
    case 'gateway-busy':
      return {
        message: 'The gateway is busy. Try again in a moment.',
        actions: ['retry'],
      }
    case 'ice-failed':
      return {
        message: "Couldn't reach the gateway: no direct or relayed route.",
        actions: ['retry'],
      }
    case 'direct-only':
      return {
        message:
          'This gateway allows direct connections only, and no direct connection reached it.',
        actions: ['retry'],
      }
    case 'not-paired':
      return {
        message:
          "This browser isn't paired with this gateway (anymore). Pair it again.",
        actions: ['pair'],
      }
    case 'pin-mismatch':
      return {
        message:
          "Refused: this is not the gateway you paired with. Don't continue unless you re-installed the gateway yourself; then pair again.",
        actions: ['pair'],
        loud: true,
      }
    case 'code-mismatch':
      return {
        message:
          "The codes didn't match, so this browser wasn't paired. If you approved a request on the gateway page, remove that client under Paired clients. Then pair again and approve only the request showing this browser's code.",
        actions: ['pair'],
      }
    case 'gateway-refused':
      return {
        message: 'The gateway refused this browser.',
        actions: ['gateways'],
      }
    case 'tunnel-lost':
      return {
        message: 'Lost the connection to the gateway.',
        actions: ['retry'],
      }
    case 'media-server-down':
      return {
        message: "The gateway is up, but its media server isn't reachable.",
        actions: ['retry'],
      }
    case 'invite-invalid':
      return {
        message:
          "This invite link isn't valid anymore: it expired, was already used, or was revoked. Ask for a new one.",
        actions: ['gateways'],
      }
    case 'last-admin':
      return {
        message:
          'A household needs at least one admin. Make someone else admin first.',
        actions: [],
      }
    case 'admin-only':
      // Retry can't help: the role only changes when an admin changes it.
      return { message: ADMIN_ONLY, actions: [] }
    case 'unauthorized':
      return { message: 'Your session expired.', actions: ['sign-in'] }
    case 'http':
      return { message: 'Request failed.', actions: ['retry'] }
    case 'network':
      return {
        message: "Couldn't reach StreamIQ: offline?",
        actions: ['retry'],
      }
    case 'playback':
      return { message: e.message, actions: [] }
    case 'unknown':
      return { message: 'Something went wrong.', actions: ['retry'] }
  }
}
