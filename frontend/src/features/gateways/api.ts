import { authed } from '../../api'

export type Gateway = {
  id: string
  name: string | null
  lastSeenAt: string | null
  lanUrl: string | null
  version: string | null
  online: boolean
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
