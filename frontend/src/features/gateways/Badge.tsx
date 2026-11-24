// The shell's top-right badge: the active gateway's dot, its name and the
// household's initial only when they tell things apart, and how this
// device reaches it (the player's privacy badge, RouteBadge). On a library
// route the library's live tunnel feeds it (LiveRoute); elsewhere one short
// check per page load and gateway (the diagnostics "Test connection" path),
// kept in the query cache until a library tunnel overwrites it.
import { useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { connect } from '../pairing/connect'
import { getPin } from '../pairing/store'
import { pairInfo } from '../../shared/stats'
import { event } from '../../shared/diag'
import { RouteBadge } from '../player/Privacy'
import { useOnLan, usePairInfo } from '../library/queries'
import { routeOn, type Gateway } from './api'
import {
  badgeNames,
  connKey,
  connPart,
  isRoute,
  routeOf,
  type Conn,
} from './connection'

// One tunnel, closed once it has its answer: one line in the gateway's
// tunnel history. A gateway without /streamiq/route: not on your network.
// No pin: no tunnel (the gateway would refuse it and log a failed line).
async function check(gatewayId: string, direct: boolean): Promise<Conn> {
  try {
    if (!(await getPin(gatewayId))) return { route: 'unpaired' }
    const s = await connect(gatewayId, undefined, undefined, direct)
    try {
      const [stats, lan] = await Promise.all([
        s.pc.getStats(),
        routeOn(s.pc).then(
          (r) => r.route === 'lan',
          () => false,
        ),
      ])
      return { route: routeOf(!!pairInfo(stats)?.relay, lan) }
    } finally {
      s.close()
    }
  } catch (e) {
    event(`connection check failed: ${e}`)
    return { route: 'failed' }
  }
}

export function GatewayBadge({
  id,
  gateway,
  gateways,
  household,
  households,
  dot,
  live,
}: {
  id: string
  gateway?: Gateway
  /** In the active household. */
  gateways: number
  household: string
  /** The user's memberships. */
  households: number
  dot: string
  /** A library route: its tunnel answers, no check. */
  live: boolean
}) {
  const conn = useQuery({
    queryKey: connKey(id),
    queryFn: () => check(id, !!gateway?.relayOff),
    enabled: dot === 'online' && !live,
    staleTime: Infinity,
    gcTime: Infinity,
  }).data
  const note = { failed: 'status unavailable', offline: 'offline' }[dot]
  const n = badgeNames(
    gateway?.name ?? 'Gateway',
    gateways,
    household,
    households,
  )
  const part = connPart(dot, conn)
  // In the route's button when there is one: one focus stop, and a tap on
  // the initial opens the popover that names the household.
  const lead = <Names initial={n.initial} name={n.name} />
  return (
    <span className="chip conn">
      <span
        className={`dot ${dot}`}
        role="img"
        aria-label={dot === 'failed' ? 'status unavailable' : dot}
      />
      {!isRoute(part) && lead}
      {note && (
        <span className="muted" aria-hidden="true">
          {n.name && '· '}
          {note}
        </span>
      )}
      {isRoute(part) ? (
        // mb: only while its tunnel is live, not frozen after leaving
        <RouteBadge
          route={part}
          mb={live ? conn?.mb : undefined}
          lead={lead}
          heading={n.heading}
        />
      ) : (
        <Part part={part} />
      )}
    </span>
  )
}

function Names({
  initial,
  name,
}: {
  initial: string | null
  name: string | null
}) {
  return (
    <>
      {initial && (
        <span className="initial" aria-hidden="true">
          {initial}
        </span>
      )}
      {name && <span className="gw">{name}</span>}
    </>
  )
}

function Part({ part }: { part: 'checking' | 'failed' | 'unpaired' | null }) {
  if (part === 'checking')
    return (
      <span className="muted" role="status">
        Checking…
      </span>
    )
  if (part === 'failed') return <Link to="/diagnostics">Can't connect</Link>
  if (part === 'unpaired') return <Link to="/gateways">Not paired</Link>
  return null
}

/** Feeds the shell badge from the library's live tunnel; renders nothing. */
export function LiveRoute({
  gatewayId,
  pc,
}: {
  gatewayId: string
  pc: RTCPeerConnection
}) {
  const p = usePairInfo(gatewayId, pc)
  const lan = useOnLan(gatewayId, pc)
  const qc = useQueryClient()
  useEffect(() => {
    if (p && lan !== null)
      qc.setQueryData<Conn>(connKey(gatewayId), {
        route: routeOf(p.relay, lan),
        mb: (p.bytesReceived + p.bytesSent) / 1e6,
      })
  }, [p, lan, gatewayId, qc])
  return null
}
