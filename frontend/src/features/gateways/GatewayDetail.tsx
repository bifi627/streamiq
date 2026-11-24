import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { removeGateway, renameGateway, type Gateway, useGateways } from './api'
import { Pairing } from '../pairing/Pairing'
import { dropShared } from '../pairing/connect'
import { deletePin, usePin } from '../pairing/store'
import { renameMessage, toAppError, type AppError } from '../../shared/errors'
import { ErrorView, State } from '../../shared/ErrorView'
import { PageBar } from '../../shared/PageBar'
import { useHousehold } from '../households/household'
import { arrowFocus } from '../../shared/focus'
import { tvOn } from '../../shared/settings'
import { EditableName, STORED } from './EditableName'
import { UpdateNotice } from './UpdateNotice'
import { StatusDetails } from './StatusDetails'
import { HealthHistory } from './HealthHistory'
import { PairedClients } from './PairedClients'
import { RelaySetting } from './RelaySetting'
import { canManage, gatewayName, shownError, type ActErr } from './list'
import { event } from '../../shared/diag'

// `/gateways/$id`: one gateway's card with every detail and action.
// TODO(#870) the detail page replaces it. Rename/Remove are admin-only.
export function GatewayDetail({ id }: { id: string }) {
  const q = useGateways(5000)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const g = q.data?.find((x) => x.id === id)
  const admin = useHousehold().current?.role === 'admin'
  // An action's error, until the next successful poll (as the load error).
  const [actErr, setActErr] = useState<ActErr | null>(null)
  const setErr = (e: AppError) =>
    setActErr({ e, at: qc.getQueryState(['gateways'])?.dataUpdatedAt ?? 0 })
  const err = shownError(
    q.error ? toAppError(q.error) : null,
    actErr,
    q.dataUpdatedAt,
  )
  const removing = useMutation({
    mutationFn: removeGateway,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['gateways'] })
      void navigate({ to: '/gateways' })
    },
    onError: (e) => setErr(toAppError(e)),
  })
  // null = renamed; else the error to show in the form.
  async function rename(d: Gateway, name: string) {
    try {
      const stored = await renameGateway(d.id, name)
      // Shown at once; the gateway tells the API with a heartbeat on rename.
      qc.setQueryData<Gateway[]>(['gateways'], (gs) =>
        gs?.map((x) => (x.id === d.id ? { ...x, name: stored } : x)),
      )
      void qc.invalidateQueries({ queryKey: ['gateways'] })
      return null
    } catch (e) {
      return renameMessage(toAppError(e))
    }
  }

  return (
    <section className="gateways" onKeyDown={arrowFocus}>
      <PageBar
        title={g ? gatewayName(g) : 'Gateway'}
        onBack={() => navigate({ to: '/gateways' })}
      />
      {err && <ErrorView error={err} />}
      {q.data && !g && (
        <State icon="gateway" title="This gateway isn't in the household.">
          <p className="state-actions">
            <Link to="/gateways">Go to your gateways</Link>
          </p>
        </State>
      )}
      {g && (
        <ul className="cards">
          <GatewayCard
            g={g}
            admin={admin}
            onRename={(n) => rename(g, n)}
            onRemove={() => removing.mutate(g.id)}
          />
        </ul>
      )}
    </section>
  )
}

// One gateway's card. onRename / onRemove: the list's, it owns the query.
function GatewayCard({
  g,
  admin,
  onRename,
  onRemove,
}: {
  g: Gateway
  admin: boolean
  onRename: (name: string) => Promise<string | null>
  onRemove: () => void
}) {
  const navigate = useNavigate()
  // This browser holds a pin for it: Rename and Update go over the tunnel, so
  // they show only then.
  const [pinned, setPinned] = usePin(g.id)
  const manage = canManage(admin, g.online, !!pinned)
  // This browser removed itself from it: Pair shows again.
  const [unpaired, setUnpaired] = useState(false)
  async function removedSelf() {
    await deletePin(g.id).catch((e) =>
      event(`pairing: pin delete failed: ${e}`),
    ) // a stale pin would only fail later
    dropShared(g.id) // the gateway closed it anyway
    setPinned(false)
    setUnpaired(true)
  }
  function remove() {
    if (
      confirm(
        `Remove "${gatewayName(g)}"? It disconnects now and must be installed again to come back.`,
      )
    )
      onRemove()
  }
  return (
    <li className="card" data-gateway={g.id}>
      <div className="card-head">
        <EditableName
          name={gatewayName(g)}
          label="Gateway name"
          hint={STORED}
          rename={manage ? onRename : undefined}
        />
        <span className="chip">
          <span className={g.online ? 'dot online' : 'dot'} />
          {g.online ? 'Online' : 'Offline'}
        </span>
      </div>
      {g.version && (
        <span className="meta muted no-tv">Version {g.version}</span>
      )}
      {g.upgradeRequired ? (
        <p className="notice no-tv">
          Update required: rerun the install command on the gateway.
        </p>
      ) : (
        // Not mounted on a TV: hidden there, and its status call would go unseen.
        !tvOn() && <UpdateNotice g={g} canUpdate={manage} />
      )}
      {g.online ? (
        // Pair this browser stands where Open is until it's paired.
        <Pairing
          gatewayId={g.id}
          lanUrl={g.lanUrl}
          needsPair={unpaired}
          onPaired={() => {
            setPinned(true)
            setUnpaired(false)
          }}
          open={() =>
            navigate({ to: '/g/$gatewayId', params: { gatewayId: g.id } })
          }
        >
          {/* Every device; TV mode also has it in the top bar (App.tsx). */}
          {!unpaired && (
            <Link to="/g/$gatewayId/screen" params={{ gatewayId: g.id }}>
              Use as screen
            </Link>
          )}
          {g.lanUrl && (
            <a
              className="no-tv"
              href={g.lanUrl}
              target="_blank"
              rel="noreferrer"
            >
              Gateway page
            </a>
          )}
          {admin && <RemoveButton onClick={remove} />}
        </Pairing>
      ) : (
        admin && (
          <div className="actions no-tv">
            <RemoveButton onClick={remove} />
          </div>
        )
      )}
      <RelaySetting g={g} manage={manage} />
      <StatusDetails g={g} />
      <HealthHistory g={g} paired={pinned === true} /* removedSelf unpins */ />
      {/* A member's list is just this browser. */}
      <PairedClients g={g} unpaired={unpaired} onRemovedSelf={removedSelf} />
    </li>
  )
}

const RemoveButton = ({ onClick }: { onClick: () => void }) => (
  <button type="button" className="end no-tv" onClick={onClick}>
    Remove
  </button>
)
