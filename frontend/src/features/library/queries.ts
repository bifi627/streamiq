// The library's polls and reads over the gateway's open tunnel. Keyed by
// gatewayId: the queryFn always runs on the pc it was last rendered with.
import { useQuery } from '@tanstack/react-query'
import { pairInfo } from '../../shared/stats'
import { routeOn, screensOn, statusOn } from '../gateways/api'
import { useTunnelQuery } from './art'
import type { Item } from './items'
import * as jf from './jellyfin'
import { polled } from '../screen/remote'

type PC = RTCPeerConnection

/** The live selected candidate pair; a failed read keeps the last one. */
export const usePairInfo = (gatewayId: string, pc: PC) =>
  useQuery({
    queryKey: ['pairInfo', gatewayId],
    queryFn: async () => pairInfo(await pc.getStats()),
    refetchInterval: 2000,
    gcTime: 0,
  }).data ?? null

/** Whether the gateway sees this device on its own subnet; null: not asked yet.
 * A gateway without /streamiq/route answers 404: false (relayed or direct only). */
export function useOnLan(gatewayId: string, pc: PC) {
  const q = useQuery({
    queryKey: ['route', gatewayId],
    queryFn: async () => (await routeOn(pc)).route === 'lan',
    // ponytail: every 10 s, a changed network shows up that late; each ask is a request
    refetchInterval: 10_000,
    gcTime: 0,
  })
  return q.data ?? (q.isError ? false : null) // the last answer survives a hiccup
}

/** The gateway status for the guest banner, once per mount; null: none.
 * Not a ['tunnel', …] key: the player cancels those on open (engine.ts). */
export const useGuestStatus = (gatewayId: string, pc: PC) =>
  useQuery({
    queryKey: ['guestStatus', gatewayId],
    queryFn: () => statusOn(pc),
    staleTime: Infinity,
    gcTime: 0,
  }).data ?? null

/** GET /streamiq/screens every second until screenId is closed. */
export const useScreens = (gatewayId: string, pc: PC, screenId: string) =>
  useQuery({
    queryKey: ['screens', gatewayId],
    queryFn: () => screensOn(pc),
    refetchInterval: (q) =>
      polled(screenId, q.state.data, '').again ? 1000 : false,
    gcTime: 0,
  })

/** The gateway's open screens for Play on…; a screen opened meanwhile
 * shows within 10 s. ponytail: a poll per web gateway page, not pushed. */
export const useOpenScreens = (gatewayId: string, pc: PC, enabled: boolean) =>
  useQuery({
    enabled,
    queryKey: ['openScreens', gatewayId],
    queryFn: () => screensOn(pc),
    refetchInterval: 10_000,
    gcTime: 0,
  }).data

/** The series' episode after itemId, if any. */
export function useNext(itemId: string, series?: string) {
  // This episode and the one after it, not the whole series.
  const items = useTunnelQuery<{ Items: Item[] }>(
    series ? jf.nextEpisodes(series, itemId) : null,
  ).data?.Items
  // Not listed first (e.g. missing): no button.
  return series && items?.[0]?.Id === itemId ? items[1] : undefined
}
