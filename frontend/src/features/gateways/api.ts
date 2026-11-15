import { authed } from '../../api'
import { share } from '../pairing/connect'
import { tunnelFetch, tunnelJson } from '../../tunnel'
import { httpError } from '../../errors'

export type Gateway = {
  id: string
  name: string | null
  lastSeenAt: string | null
  lanUrl: string | null
  version: string | null
  online: boolean
  update: string | null // newer gateway release, null = up to date
  upgradeRequired: boolean // refused: its protocol is below the API's minimum (#176)
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
    token?: 'ok' | 'missing' | 'legacy'
  }
  viewer?: { shared?: boolean; reason?: string } // this session's (#242); reason: see guest.ts
  remoteUpdate?: true | string // #312: the update button works, or why not
}

// Screens: phone as remote (docs/protocol.md, "Screens"). Used by Library.tsx.
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

export const removeGateway = (id: string) =>
  authed(`/gateways/${id}`, { method: 'DELETE' })

// Gateway API POST /streamiq/name (#310) over the shared session (#152): the
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

// Paired clients (#311), gateway API over the shared session: the list and
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

export const removeClient = (id: string, keyFp: string) =>
  viaTunnel(id, '/streamiq/clients/remove', { keyFp })

export const createEnrollmentToken = () =>
  authed<Install>('/gateways/enrollment-tokens', { method: 'POST' })

// Gateway API POST /streamiq/update (#312): 202 → the version it installs, then
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
