// The app's one error model (#45). Producers (connect, api, tunnel) throw an
// AppError with a kind; views render it through describe() / <ErrorView>. The
// message is the technical detail (what diagnostics log); user text lives in
// describe(). No imports, so node:test can drive it.

export type Kind =
  | 'broker-unreachable' // broker socket closed before it opened: offline or rate-limited (a 429 is invisible to JS)
  | 'broker-lost' // broker socket dropped after it opened
  | 'gateway-offline'
  | 'ice-failed'
  | 'not-paired'
  | 'pin-mismatch'
  | 'gateway-refused'
  | 'tunnel-lost' // a request on an established tunnel got no (full) response
  | 'media-server-down' // gateway answered 502/503: Jellyfin down or no token
  | 'invite-invalid' // invite link unknown, expired, used or revoked (API 404)
  | 'last-admin' // the change would leave the household without an admin (API 409)
  | 'unauthorized' // API 401
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
      : via === 'tunnel' && (status === 502 || status === 503)
        ? 'media-server-down'
        : 'http'
  return new AppError(kind, detail, { ...context, status })
}

/** The broker socket closed. Before open: offline, or the upgrade was refused
 * (a 429 rate limit is invisible to JS). After: a drop. */
export const brokerClosed = (opened: boolean, context: Context = {}) =>
  opened
    ? new AppError('broker-lost', 'broker connection closed', context)
    : new AppError('broker-unreachable', 'broker connection failed', context)

/** The broker's `{type:"error"}` text (docs/protocol.md). */
export const brokerError = (text: string, context: Context = {}) =>
  new AppError(
    /offline/i.test(text) ? 'gateway-offline' : 'unknown',
    text,
    context,
  )

export type Action = 'retry' | 'pair' | 'gateways' | 'sign-in'

// ponytail: placeholder wording; the real text comes with the design pass (#93).
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
    case 'gateway-offline':
      return {
        message: 'The gateway is offline.',
        actions: ['retry', 'gateways'],
      }
    case 'ice-failed':
      return {
        message: "Couldn't reach the gateway: no direct or relayed route.",
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
