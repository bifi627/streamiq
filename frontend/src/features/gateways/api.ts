import { authed } from '../../api'

export type Gateway = {
  id: string
  name: string | null
  lastSeenAt: string | null
  lanUrl: string | null
  version: string | null
  online: boolean
  status: GatewayStatus | null // last heartbeat's snapshot, kept while offline; null = older gateway
}

// Every field optional: the API drops anything a gateway sent malformed.
export type GatewayStatus = {
  os?: string
  arch?: string
  startedAt?: string
  update?: string // newer release version
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
