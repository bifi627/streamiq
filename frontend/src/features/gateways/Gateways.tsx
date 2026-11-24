import { useEffect, useState } from 'react'
import { PageBar } from '../../shared/PageBar'
import {
  createEnrollmentToken,
  removeGateway,
  renameGateway,
  type Gateway,
  type Install,
  useGateways,
} from './api'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pairing } from '../pairing/Pairing'
import { dropShared } from '../pairing/connect'
import { deletePin, usePin } from '../pairing/store'
import { renameMessage, toAppError, type AppError } from '../../shared/errors'
import { ErrorView, State } from '../../shared/ErrorView'
import { copyText } from '../../shared/clipboard'
import { Link, useNavigate } from '@tanstack/react-router'
import { useHousehold } from '../households/household'
import { arrowFocus } from '../../shared/focus'
import { lastGateway, tvOn } from '../../shared/settings'
import { libraryTarget } from '../../shell'
import { EditableName, STORED } from './EditableName'
import { UpdateNotice } from './UpdateNotice'
import { StatusDetails } from './StatusDetails'
import { HealthHistory } from './HealthHistory'
import { PairedClients } from './PairedClients'
import { RelaySetting } from './RelaySetting'
import { canManage, gatewayName, shownError, type ActErr } from './list'
import { event } from '../../shared/diag'

// `/`: straight into the active gateway's library, the list without a
// gateway. History replace both ways, so Back doesn't bounce.
export function Home() {
  const navigate = useNavigate()
  const { data, isError } = useGateways()
  useEffect(() => {
    if (!data && !isError) return // the list shows the error
    const id = data && libraryTarget(undefined, lastGateway(), data)
    if (id)
      navigate({ to: '/g/$gatewayId', params: { gatewayId: id }, replace: true })
    else navigate({ to: '/gateways', replace: true })
  }, [data, isError, navigate])
  return null
}

// Gateways list + "Add gateway" (onboarding flow 1). Polls so a freshly installed
// gateway shows up, and online/offline stays current. ponytail: 5s poll, push
// updates over a socket if the list ever gets big. Add/Remove are admin-only:
// hidden for a member (the API answers 403 anyway) and until /me is in;
// a member gets told an admin does them instead.
// oxlint-disable-next-line complexity -- render branching
export function Gateways() {
  const q = useGateways(5000)
  const qc = useQueryClient()
  const gateways = q.data ?? null // null = loading
  const role = useHousehold().current?.role
  const admin = role === 'admin'
  const [install, setInstall] = useState<Install | null>(null)
  // An action's error, until the next successful poll (as the load error).
  const [actErr, setActErr] = useState<ActErr | null>(null)
  // Tagged with the data at failure, not at click: a poll may land meanwhile.
  const setErr = (e: AppError) =>
    setActErr({ e, at: qc.getQueryState(['gateways'])?.dataUpdatedAt ?? 0 })
  const err = shownError(
    q.error ? toAppError(q.error) : null,
    actErr,
    q.dataUpdatedAt,
  )
  const removing = useMutation({
    mutationFn: removeGateway,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gateways'] }),
    onError: (e) => setErr(toAppError(e)),
  })
  // null = renamed; else the error to show in the form.
  async function rename(d: Gateway, name: string) {
    try {
      const stored = await renameGateway(d.id, name)
      // Shown at once; the gateway tells the API with a heartbeat on rename.
      qc.setQueryData<Gateway[]>(['gateways'], (gs) =>
        gs?.map((g) => (g.id === d.id ? { ...g, name: stored } : g)),
      )
      void qc.invalidateQueries({ queryKey: ['gateways'] })
      return null
    } catch (e) {
      return renameMessage(toAppError(e))
    }
  }

  async function addGateway() {
    try {
      setInstall(await createEnrollmentToken())
    } catch (e) {
      setErr(toAppError(e))
    }
  }

  return (
    <section className="gateways" onKeyDown={arrowFocus}>
      <PageBar
        title="Gateways"
        actions={
          // No gateways: the empty state carries it instead.
          admin &&
          gateways?.length !== 0 && (
            <button type="button" className="no-tv" onClick={addGateway}>
              Add gateway
            </button>
          )
        }
      />
      {err && <ErrorView error={err} />}
      {/* Keyed by the command (it holds the token): a new token resets Copied. */}
      {install && (
        <InstallCard key={install.installCommand} install={install} />
      )}
      {!gateways && !err && (
        <ul className="cards" role="status" aria-label="Loading">
          {[0, 1].map((n) => (
            <li key={n} className="card">
              <div className="ph ph-h2" />
              <div className="ph ph-line short" />
              <div className="ph ph-btn" />
            </li>
          ))}
        </ul>
      )}
      {gateways?.length === 0 && (
        <State
          icon="gateway"
          title="No gateways yet."
          text={role === 'member' && 'Ask a household admin to add one.'}
        >
          {admin && (
            <p className="state-actions no-tv">
              <button type="button" className="primary" onClick={addGateway}>
                Add gateway
              </button>
            </p>
          )}
        </State>
      )}
      {!!gateways?.length && (
        <ul className="cards">
          {gateways.map((d) => (
            <GatewayCard
              key={d.id}
              g={d}
              admin={admin}
              onRename={(n) => rename(d, n)}
              onRemove={() => removing.mutate(d.id)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

// The install commands for a fresh enrollment token. No clipboard API on plain
// http (a LAN address): a click on the command selects all of it instead (CSS
// user-select: all).
function InstallCard({ install }: { install: Install }) {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (label: string, cmd: string) =>
    copyText(cmd).then((ok) => ok && setCopied(label))
  return (
    <div className="card install no-tv">
      <h2>Add a gateway</h2>
      <p className="muted">
        Run one of these on your NAS or PC. The token works once and expires at{' '}
        {new Date(install.expiresAt).toLocaleTimeString()}.
      </p>
      {[
        ['bash', install.installCommand],
        ['PowerShell', install.installCommandPowershell],
      ].map(([label, cmd]) => (
        <div key={label}>
          <div className="cmd-head">
            <b>
              {label}
              {cmd.includes('go run') && (
                <span className="meta muted">
                  {' '}
                  (from <code>gateway/</code>)
                </span>
              )}
            </b>
            <button type="button" onClick={() => copy(label, cmd)}>
              {copied === label ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre>{cmd}</pre>
        </div>
      ))}
    </div>
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
