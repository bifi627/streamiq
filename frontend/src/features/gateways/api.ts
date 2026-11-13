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
