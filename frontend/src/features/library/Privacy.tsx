// Privacy badge (#205): what StreamIQ can see of this stream, from the live
// selected candidate pair. Either way the tunnel is DTLS end to end (pinned
// both ways). Focusing or clicking the badge shows the one-line explanation
// (CSS: .badge:focus / [aria-expanded] + .explain); the relayed MB live there.
import { useEffect, useState } from 'react'
import { pairInfo, type PairInfo } from '../../stats'

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
  const label = p.relay ? 'Relayed · encrypted' : 'Direct from home'
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
          {p.relay ? (
            <path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6z" />
          ) : (
            <path d="M3 11l9-7 9 7M5 10v10h14V10" />
          )}
        </svg>
        <span className="badge-text">{label}</span>
      </button>
      <span className="explain">
        {p.relay
          ? `Your networks couldn't connect directly, so the stream passes an encrypted relay that can't see it · ${mb} MB relayed`
          : 'Straight from your home to this device, end-to-end encrypted · StreamIQ carried 0 bytes'}
      </span>
    </span>
  )
}
