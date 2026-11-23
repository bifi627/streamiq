// The shell's top-right badge: the active gateway with its dot, and how this
// device reaches it (the player's privacy badge, RouteBadge). On a library
// route the library's live tunnel feeds it (LiveRoute); elsewhere one short
// check per page load and gateway (the diagnostics "Test connection" path),
// kept in the query cache until a library tunnel overwrites it.
import { useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { connect } from '../pairing/connect'
import { pairInfo } from '../../shared/stats'
import { event } from '../../shared/diag'
import { RouteBadge } from '../player/Privacy'
import { useOnLan, usePairInfo } from '../library/queries'
import { routeOn, type Gateway } from './api'
import { connKey, connPart, routeOf, type Conn } from './connection'

// One tunnel, closed once it has its answer: one line in the gateway's
// tunnel history. A gateway without /streamiq/route: not on your network.
async function check(gatewayId: string, direct: boolean): Promise<Conn> {
  try {
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
  dot,
  live,
}: {
  id: string
  gateway?: Gateway
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
  return (
    <span className="chip conn">
      <span
        className={`dot ${dot}`}
        role="img"
        aria-label={dot === 'failed' ? 'status unavailable' : dot}
      />
      {gateway?.name ?? 'Gateway'}
      {note && (
        <span className="muted" aria-hidden="true">
          · {note}
        </span>
      )}
      <Part part={connPart(dot, conn)} mb={conn?.mb} />
    </span>
  )
}

function Part({
  part,
  mb,
}: {
  part: ReturnType<typeof connPart>
  mb?: number
}) {
  if (part === 'checking')
    return (
      <span className="muted" role="status">
        Checking…
      </span>
    )
  if (part === 'failed') return <Link to="/diagnostics">Can't connect</Link>
  return part && <RouteBadge route={part} mb={mb} />
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
