import { Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { listClients, viaTunnel } from './api'
import { PageBar } from '../../shared/PageBar'
import { toAppError } from '../../shared/errors'
import { useHousehold } from '../households/household'
import type { Item } from '../library/items'
import * as jf from '../library/jellyfin'
import { clientsMessage } from './list'
import {
  episodesLine,
  profiled,
  report,
  reportNote,
  type Row,
} from './transcodeReport'

// `/gateways/$id/transcodes` (admin): the library items some paired client
// would transcode, from the clients' stored probes. The whole library
// is read over the shared tunnel once per open, in pages (the gateway caps a
// response at 16 MiB).
export function Transcodes({ id }: { id: string }) {
  const navigate = useNavigate()
  const role = useHousehold().current?.role
  const admin = role === undefined ? undefined : role === 'admin'
  const q = useQuery({
    queryKey: ['transcodes', id],
    enabled: !!admin,
    queryFn: async () => {
      const [clients, items] = await Promise.all([listClients(id), library(id)])
      const p = profiled(clients)
      return { ...p, rows: report(items, p.clients) }
    },
    gcTime: 0,
    retry: false, // each try reads the whole library
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const d = q.data
  const note = reportNote({
    admin,
    probed: d?.clients.length ?? 0,
    error: q.error ? clientsMessage(toAppError(q.error)) : null,
    loaded: !!d,
  })
  return (
    <section className="gateways transcodes">
      <PageBar
        title="Transcode report"
        onBack={() => navigate({ to: '/gateways/$id', params: { id } })}
      />
      <p>
        Library items that at least one paired client can't play as they are,
        from what each client's browser decoded at its last playback.
      </p>
      {!!d?.notProbed.length && <p>Not probed yet: {d.notProbed.join(', ')}</p>}
      {note ? <p role="status">{note}</p> : d && <Rows rows={d.rows} />}
    </section>
  )
}

const PAGE = 500

async function library(id: string) {
  const out: Item[] = []
  for (;;) {
    const p = await viaTunnel<{ Items: Item[]; TotalRecordCount: number }>(
      id,
      jf.allVideos(out.length, PAGE),
    )
    out.push(...p.Items)
    if (p.Items.length < PAGE || out.length >= p.TotalRecordCount) return out
  }
}

function Rows({ rows }: { rows: Row[] }) {
  if (!rows.length)
    return <p>Every item plays without a transcode on every probed client.</p>
  return (
    <div className="card">
      <ul className="clients">
        {rows.map((r) => (
          <li key={r.id}>
            <span>
              {r.name}
              {r.episodes && ` · ${episodesLine(r.episodes)}`}
            </span>
            {r.reasons.map((x) => (
              <small key={x.text} className="profile">
                {x.text} · {x.clients.join(', ')}
              </small>
            ))}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The report's link under Paired clients: an admin who can reach the gateway. */
export function ReportLink({ id, show }: { id: string; show: boolean }) {
  if (!show) return null
  return (
    <p>
      <Link to="/gateways/$id/transcodes" params={{ id }}>
        Transcode report
      </Link>
    </p>
  )
}
