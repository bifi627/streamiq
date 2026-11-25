import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { decideRequest, listRequests, type Gateway } from './api'
import { toAppError } from '../../shared/errors'
import { useMembers } from '../activity/useMembers'
import {
  decideMessage,
  nextRequestsAsk,
  requesterLine,
  requestsView,
} from './requests'

// Pending pairing requests on the web gateway page (admin, paired browser):
// Approve/Reject go over this browser's tunnel to the gateway, as on the local
// gateway page. Polled while the page is open.
export function PairingRequests({ g }: { g: Gateway }) {
  const q = useQuery({
    queryKey: ['pairingRequests', g.id],
    queryFn: () => listRequests(g.id),
    refetchInterval: (x) => nextRequestsAsk(x.state.status === 'error'),
    gcTime: 0,
    refetchOnWindowFocus: false, // a retry would open a tunnel
    refetchOnReconnect: false,
    retry: false,
  })
  const { names } = useMembers(true, undefined)
  // A failed decide's line, until the next poll (at = its dataUpdatedAt).
  const [msg, setMsg] = useState<{ text: string; at: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const view = requestsView(q.data, q.error ? toAppError(q.error) : null)
  if (view === 'hidden') return null

  async function decide(id: string, approve: boolean) {
    setBusy(true) // a double click would 404 as "ended"
    let text: string | null = null
    try {
      await decideRequest(g.id, id, approve)
    } catch (x) {
      text = decideMessage(toAppError(x))
    }
    const r = await q.refetch()
    setMsg(text === null ? null : { text, at: r.dataUpdatedAt })
    setBusy(false)
  }

  return (
    <section className="pairing-requests" aria-label="Pairing requests">
      <h2>Pairing requests</h2>
      {msg?.at === q.dataUpdatedAt && <p role="status">{msg.text}</p>}
      {'msg' in view ? (
        <p role="status">{view.msg}</p>
      ) : (
        view.map((r) => (
          <div key={r.id} className="pair-box">
            <output className="pair-code" aria-label="Comparison code">
              {r.code}
            </output>
            <p>{requesterLine(r, names)} wants to pair.</p>
            <p>
              Compare this code with theirs: approve only if it is the same.
            </p>
            <p className="actions">
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => decide(r.id, true)}
              >
                Approve
              </button>{' '}
              <button
                type="button"
                disabled={busy}
                onClick={() => decide(r.id, false)}
              >
                Reject
              </button>
            </p>
          </div>
        ))
      )}
    </section>
  )
}
