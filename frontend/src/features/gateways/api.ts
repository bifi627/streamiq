import { useQuery } from '@tanstack/react-query'
import { authed } from '../../api'
import { share } from '../pairing/connect'
import { tunnelFetch, tunnelJson, tunnelLines } from '../../tunnel'
import { httpError } from '../../errors'
import { nextAsk, type HostLoad } from './host'

export type Gateway = {
  id: string
  name: string | null
  lastSeenAt: string | null
  lanUrl: string | null
  version: string | null
  online: boolean
  update: string | null // newer gateway release, null = up to date
  upgradeRequired: boolean // refused: its protocol is below the API's minimum
}

// Gateway API GET /streamiq/status over the tunnel (docs/protocol.md). All
// optional: older gateways send fewer fields.
export type GatewayStatus = {
  transcoding?: string
  os?: string
  arch?: string
  startedAt?: string
  pairedClients?: number
  activeSessions?: number
  jellyfin?: {
    reachable?: boolean
    version?: string
    untested?: boolean
    token?: 'ok' | 'missing'
    offline?: 'enforced' | 'allowed' // absent = no compose Jellyfin
  }
  viewer?: { shared?: boolean; reason?: string } // this session's; reason: see guest.ts
  remoteUpdate?: true | string // the update button works, or why not
  host?: HostLoad // live only, never cached
}

// Screens: phone as remote (docs/protocol.md, "Screens"). Used by library/Screen.tsx.
// POST /streamiq/screen/state body; GET /streamiq/screens item state.
// Ticks are integers (Math.floor them).
export type ScreenState = {
  itemId: string // '' while nothing plays
  positionTicks: number
  durationTicks: number
  paused: boolean
  audio: number | null // Jellyfin stream index, null = not known
  subtitle: number | null // -1 = off
}

// GET /streamiq/screens
export type Screen = { id: string; name: string; state: ScreenState | null }

// POST /streamiq/screens/{id} body; also each NDJSON line of GET /streamiq/screen
// (in arrival order; the stream has no EOF frame, the TV closing it ends the screen).
export type ScreenCommand =
  | { type: 'play'; itemId: string; startTicks?: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'seek'; ticks: number }
  | { type: 'tracks'; audio?: number; subtitle?: number } // at least one; subtitle -1 = off

export type Install = {
  token: string
  expiresAt: string
  installCommand: string
  installCommandPowershell: string
}

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
      await tunnelJson<{ name: string }>(x.pc, '/streamiq/name', { name })
    ).name
  } finally {
    release()
  }
}

// Paired clients, gateway API over the shared session: the list and
// the allowlist live on the gateway only, the API never sees them.
export type Client = {
  keyFp: string
  name: string
  addedAt: string
  self: boolean
}

async function viaTunnel<T>(id: string, url: string, body?: unknown) {
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

export const removeClient = (id: string, keyFp: string) =>
  viaTunnel(id, '/streamiq/clients/remove', { keyFp })

export const renameClient = async (id: string, keyFp: string, name: string) =>
  (
    await viaTunnel<{ name: string }>(id, '/streamiq/clients/rename', {
      keyFp,
      name,
    })
  ).name

export const createEnrollmentToken = () =>
  authed<Install>('/gateways/enrollment-tokens', { method: 'POST' })

// Gateway API POST /streamiq/update: 202 → the version it installs, then
// the gateway goes down for the swap; 409 → why it won't (the reply's reason).
export async function updateGateway(
  id: string,
): Promise<{ version: string } | { reason: string }> {
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
export type Route = { route: string }
export const routeOn = (pc: PC) => tunnelJson<Route>(pc, '/streamiq/route')

// GET /streamiq/burst: the raw response, so the speed test times it.
export const burstOn = (pc: PC, size: number) =>
  tunnelFetch(pc, `/streamiq/burst?size=${size}`)

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
