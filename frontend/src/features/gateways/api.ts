import { authed } from '../../api'

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

export const createEnrollmentToken = () =>
  authed<Install>('/gateways/enrollment-tokens', { method: 'POST' })
