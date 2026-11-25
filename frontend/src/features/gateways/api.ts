import { useQuery } from '@tanstack/react-query'
import { authed } from '../../shared/api'
import { connect, share } from '../pairing/connect'
import { tunnelFetch, tunnelJson, tunnelLines } from '../../shared/tunnel'
import { httpError } from '../../shared/errors'
import { nextAsk } from './host'
import { routeOf } from './connection'
import { pairInfo } from '../../shared/stats'
import type { Gateway } from '../../generated/gateways'
import type { EnrollmentToken as Install } from '../../generated/onboarding'
import type { Name, Relay } from '../../generated/gateway-onboarding'
import type { Client, ClientKey, ClientName } from '../../generated/pairing'
import type { Status } from '../../generated/status'
import type { HealthRow } from '../../generated/history'
import type { Route } from '../../generated/tunnel'
import type { Screen, ScreenCommand, ScreenState } from '../../generated/screen'
import type { Refused, Started } from '../../generated/update'

export type { Gateway, Install }

// The gateway API's bodies (docs/protocol.md, "Gateway API"), generated from the
// gateway's Go types. Status: any field may be missing, older gateways send fewer.
export type GatewayStatus = Partial<Status>
export type { Client, Route, Screen, ScreenCommand, ScreenState }

export const getGateways = () => authed<Gateway[]>('/gateways')

// The household's gateway list, shared by every screen that shows it. A
// refetchInterval polls only while a component asking for it is mounted.
export const useGateways = (refetchInterval?: number) =>
  useQuery({ queryKey: ['gateways'], queryFn: getGateways, refetchInterval })

export const removeGateway = (id: string) =>
  authed(`/gateways/${id}`, { method: 'DELETE' })

// Gateway API POST /streamiq/name over the shared session: the
// gateway owns its name and answers the stored one; the API learns it from the
// heartbeat.
export async function renameGateway(id: string, name: string) {
  const { session, release } = share(id)
  try {
    const x = await session
    return (
      await tunnelJson<Name>(x.pc, '/streamiq/name', { name } satisfies Name)
    ).name
  } finally {
    release()
  }
}

// Gateway API POST /streamiq/relay: the gateway owns the setting and answers the
// stored one; the API learns it from the heartbeat.
export async function setGatewayRelay(id: string, relay: boolean) {
  return !!(
    await viaTunnel<Relay>(id, '/streamiq/relay', { relay } satisfies Relay)
  ).relay
}

// Paired clients, gateway API over the shared session: the list and
// the allowlist live on the gateway only, the API never sees them.
export async function viaTunnel<T>(id: string, url: string, body?: unknown) {
  const { session, release } = share(id)
  try {
    return await tunnelJson<T>((await session).pc, url, body)
  } finally {
    release()
  }
}

export const listClients = (id: string) =>
  viaTunnel<Client[]>(id, '/streamiq/clients')

export const getStatus = (id: string) =>
  viaTunnel<GatewayStatus>(id, '/streamiq/status')

type Cached = { at: string; s: GatewayStatus }
const cacheKey = (id: string) => `streamiq.gatewayStatus.${id}`

// Offline view: the last response per gateway, from localStorage (may be
// unavailable: private mode, blocked storage). Never with `host`, also
// from a build that cached it.
export function readCache(id: string): Cached | null {
  try {
    const c = JSON.parse(localStorage.getItem(cacheKey(id)) ?? 'null')
    return c && { ...c, s: { ...c.s, host: undefined } }
  } catch {
    return null
  }
}

// Without `host`: stale load misleads.
function writeCache(id: string, s: GatewayStatus) {
  try {
    localStorage.setItem(
      cacheKey(id),
      JSON.stringify({
        at: new Date().toISOString(),
        s: { ...s, host: undefined },
      }),
    )
  } catch {
    // ignore: the live view still works
  }
}

// The details' status while online: polled every nextAsk, stopped by an
// error; each answer kept for the offline view.
export const useGatewayStatus = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: ['gatewayStatus', id],
    queryFn: async () => {
      const s = await getStatus(id)
      writeCache(id, s)
      return s
    },
    enabled,
    refetchInterval: (q) => nextAsk(q.state.status !== 'error') ?? false,
    gcTime: 0, // reopened: "checking…" again, never an old reading
    refetchOnWindowFocus: false, // nextAsk: no retry, each would open a tunnel
    refetchOnReconnect: false,
  })

// The health history: kept on the gateway, never in the API.
export const getHealth = (id: string) =>
  viaTunnel<HealthRow[]>(id, '/streamiq/health')

export const removeClient = (id: string, keyFp: string) =>
  viaTunnel(id, '/streamiq/clients/remove', { keyFp } satisfies ClientKey)

export const renameClient = async (id: string, keyFp: string, name: string) =>
  (
    await viaTunnel<ClientName>(id, '/streamiq/clients/rename', {
      keyFp,
      name,
    } satisfies ClientKey)
  ).name

export const createEnrollmentToken = () =>
  authed<Install>('/gateways/enrollment-tokens', { method: 'POST' })

// Gateway API POST /streamiq/update: 202 → the version it installs, then
// the gateway goes down for the swap; 409 → why it won't (the reply's reason).
export async function updateGateway(id: string): Promise<Started | Refused> {
  const { session, release } = share(id)
  try {
    const r = await tunnelFetch((await session).pc, '/streamiq/update', {
      method: 'POST',
      body: '{}',
    })
    if (r.status !== 202 && r.status !== 409)
      throw httpError('tunnel', r.status, '/streamiq/update')
    return JSON.parse(new TextDecoder().decode(r.body))
  } finally {
    release()
  }
}

// Gateway API calls on an already open tunnel (library, player, privacy badge,
// speed test): the caller holds the session.
type PC = RTCPeerConnection

export const statusOn = (pc: PC) =>
  tunnelJson<GatewayStatus>(pc, '/streamiq/status')

export const clientsOn = (pc: PC) =>
  tunnelJson<Client[]>(pc, '/streamiq/clients')

// GET /streamiq/route: 'lan' when the gateway sees this device on one of
// its own subnets. Older gateways answer 404.
export const routeOn = (pc: PC) => tunnelJson<Route>(pc, '/streamiq/route')

// One tunnel, closed once it has its answer: one line in the gateway's
// tunnel history. A gateway without /streamiq/route: not on your network.
// Throws what connect throws (the card's Test shows it).
export async function probe(gatewayId: string, direct: boolean) {
  const s = await connect(gatewayId, undefined, undefined, direct)
  try {
    const [stats, lan] = await Promise.all([
      s.pc.getStats(),
      routeOn(s.pc).then(
        (r) => r.route === 'lan',
        () => false,
      ),
    ])
    return routeOf(!!pairInfo(stats)?.relay, lan)
  } finally {
    s.close()
  }
}

export const screensOn = (pc: PC) =>
  tunnelJson<Screen[]>(pc, '/streamiq/screens')

export const commandScreen = (pc: PC, screenId: string, c: ScreenCommand) =>
  tunnelJson(pc, `/streamiq/screens/${screenId}`, c)

export const postScreenState = (pc: PC, s: ScreenState) =>
  tunnelFetch(pc, '/streamiq/screen/state', {
    method: 'POST',
    body: JSON.stringify(s),
  })

// GET /streamiq/screen: this browser as a screen, one ScreenCommand per line.
export const screenFeed = (
  pc: PC,
  onCommand: (c: ScreenCommand) => void,
  onEnd: (why: string) => void,
) =>
  tunnelLines(
    pc,
    '/streamiq/screen',
    (line) => onCommand(JSON.parse(line) as ScreenCommand),
    onEnd,
  )
