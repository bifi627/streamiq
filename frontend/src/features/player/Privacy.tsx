// Privacy badge: what StreamIQ can see of this stream, from the live
// selected candidate pair: relayed or direct, and on your network when the
// gateway sees this device on one of its own subnets (GET /streamiq/route:
// the browser's own stats hide its address). Every way the tunnel is DTLS end
// to end (pinned both ways).
// Focusing or clicking the badge shows the one-line explanation
// (CSS: .badge:focus / [aria-expanded] + .explain); the relayed MB live there.
import { useState, type ReactNode } from 'react'
import { useOnLan, usePairInfo } from '../library/queries'
import { routeOf, type Route } from '../gateways/connection'
import { forcedOf } from '../pairing/connect'
import { look } from './routeLook'

export function Privacy({
  gatewayId,
  pc,
}: {
  gatewayId: string
  pc: RTCPeerConnection
}) {
  const p = usePairInfo(gatewayId, pc)
  const lan = useOnLan(gatewayId, pc)
  if (!p || lan === null) return null
  return (
    <RouteBadge
      route={routeOf(p.relay, lan, forcedOf(pc))}
      mb={(p.bytesReceived + p.bytesSent) / 1e6}
    />
  )
}

/** The badge itself; mb: relayed so far, unknown after the shell's
 * short check (its explanation then leaves the figure out). lead and
 * heading: the shell badge's names, inside the button and atop the line. */
export function RouteBadge({
  route,
  mb,
  lead,
  heading,
}: {
  route: Route
  mb?: number
  lead?: ReactNode
  heading?: string
}) {
  const [open, setOpen] = useState(false)
  const relayed =
    mb === undefined
      ? ''
      : ` · ${mb.toLocaleString(undefined, {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        })} MB relayed`
  const { label, icon, explain } = look(route, relayed)
  return (
    <span className="privacy" data-route={route}>
      <button
        type="button"
        className="badge"
        aria-label={label} // the text hides on a portrait phone
        aria-expanded={open}
        onClick={(e) => {
          // A mouse click focuses it, and :focus would keep it open.
          if (open && e.detail) e.currentTarget.blur()
          setOpen(!open)
        }}
      >
        {lead}
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d={icon} />
        </svg>
        <span className="badge-text">{label}</span>
      </button>
      <span className="explain">
        {heading && <strong className="explain-head">{heading}</strong>}
        {explain}
      </span>
    </span>
  )
}
