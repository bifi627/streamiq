import { useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { removeGateway, renameGateway, type Gateway, useGateways } from './api'
import { dropShared } from '../pairing/connect'
import { deletePin, usePin } from '../pairing/store'
import { renameMessage, toAppError, type AppError } from '../../shared/errors'
import { ErrorView, State } from '../../shared/ErrorView'
import { PageBar } from '../../shared/PageBar'
import { useHousehold } from '../households/household'
import { arrowFocus } from '../../shared/focus'
import { NameForm, STORED } from './EditableName'
import { UpdateNotice } from './UpdateNotice'
import { StatusDetails } from './StatusDetails'
import { HealthHistory } from './HealthHistory'
import { PairedClients } from './PairedClients'
import { PairDialog } from './PairDialog'
import { ActionMenu, type Action } from './ActionMenu'
import { canManage, gatewayName, shownError, type ActErr } from './list'
import { event } from '../../shared/diag'

// `/gateways/$id`: one gateway's page: the update banner, Pair, and the Status,
// Health and Paired clients tiles; Rename and Remove in the title row's menu.
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
      {!g && (
        <PageBar title="Gateway" onBack={() => navigate({ to: '/gateways' })} />
      )}
      {err && <ErrorView error={err} />}
      {q.data && !g && (
        <State icon="gateway" title="This gateway isn't in the household.">
          <p className="state-actions">
            <Link to="/gateways">Go to your gateways</Link>
          </p>
        </State>
      )}
      {g && (
        <GatewayPage
          g={g}
          admin={admin}
          onRename={(n) => rename(g, n)}
          onRemove={() => removing.mutate(g.id)}
        />
      )}
    </section>
  )
}

// The page itself. onRename / onRemove: GatewayDetail's, it owns the query.
function GatewayPage({
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
  // This browser removed itself from it: Paired clients says so.
  const [unpaired, setUnpaired] = useState(false)
  const [pairing, setPairing] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const menu = useRef<HTMLButtonElement>(null)
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
  const actions: Action[] = [
    ...(manage ? [{ label: 'Rename', run: () => setRenaming(true) }] : []),
    ...(admin ? [{ label: 'Remove', run: remove }] : []),
  ]
  return (
    <div className="gateway-page" data-gateway={g.id}>
      <PageBar
        onBack={() => navigate({ to: '/gateways' })}
        title={
          // !manage: went offline mid-edit, so the name only.
          renaming && manage ? (
            <NameForm
              name={gatewayName(g)}
              label="Gateway name"
              hint={STORED}
              rename={onRename}
              onClose={() => {
                setRenaming(false)
                menu.current?.focus() // the form had it: keep the D-pad's place
              }}
            />
          ) : (
            gatewayName(g)
          )
        }
        actions={
          actions.length > 0 && (
            <ActionMenu
              label="Gateway actions"
              actions={actions}
              button={menu}
            />
          )
        }
      />
      {g.upgradeRequired ? (
        <p className="notice">
          Update required: rerun the install command on the gateway.
        </p>
      ) : (
        <UpdateNotice g={g} canUpdate={manage} />
      )}
      {g.online && pinned === false && (
        <p className="actions">
          <button
            type="button"
            className="primary"
            onClick={() => setPairing(true)}
          >
            Pair this browser
          </button>
        </p>
      )}
      {pairing && (
        <PairDialog
          g={g}
          onClose={() => setPairing(false)}
          onPaired={() => setUnpaired(false)}
        />
      )}
      <div className="gw-tiles">
        <StatusDetails g={g} manage={manage} />
        <HealthHistory
          g={g}
          paired={pinned === true} /* removedSelf unpins */
        />
        {/* A member's list is just this browser. */}
        <PairedClients g={g} unpaired={unpaired} onRemovedSelf={removedSelf} />
      </div>
    </div>
  )
}
