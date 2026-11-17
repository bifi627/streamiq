// Privacy badge (#205): what StreamIQ can see of this stream, from the live
// selected candidate pair: on your network (host ↔ host, #428), direct, or
// relayed. Every way the tunnel is DTLS end to end (pinned both ways).
// Focusing or clicking the badge shows the one-line explanation
// (CSS: .badge:focus / [aria-expanded] + .explain); the relayed MB live there.
import { useEffect, useState } from 'react'
import { pairInfo, route, type PairInfo } from '../../stats'

export function Privacy({ pc }: { pc: RTCPeerConnection }) {
  const [p, setP] = useState<PairInfo | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const poll = () =>
      pc.getStats().then(
        (s) => setP(pairInfo(s)),
        () => {},
      )
    poll()
    const t = setInterval(poll, 2000)
    return () => clearInterval(t)
  }, [pc])
  if (!p) return null
  const mb = ((p.bytesReceived + p.bytesSent) / 1e6).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })
  const { label, icon, explain } = {
    lan: {
      label: 'On your network',
      // wifi waves
      icon: 'M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01',
      explain:
        'Straight from your gateway over your home network, end-to-end encrypted · never leaves the house',
    },
    direct: {
      label: 'Direct from home',
      icon: 'M3 11l9-7 9 7M5 10v10h14V10',
      explain:
        'Straight from your home to this device, end-to-end encrypted · StreamIQ carried 0 bytes',
    },
    relay: {
      label: 'Relayed · encrypted',
      icon: 'M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6z',
      explain: `Your networks couldn't connect directly, so the stream passes an encrypted relay that can't see it · ${mb} MB relayed`,
    },
  }[route(p)]
  return (
    <span className="privacy" data-relay={p.relay}>
      <button
        type="button"
        className="badge"
        aria-label={label} // the text hides on a portrait phone
        aria-expanded={open}
        onClick={(e) => {
          // A mouse click focuses it, and :focus would keep it open (#337).
          if (open && e.detail) e.currentTarget.blur()
          setOpen(!open)
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d={icon} />
        </svg>
        <span className="badge-text">{label}</span>
      </button>
      <span className="explain">{explain}</span>
    </span>
  )
}
