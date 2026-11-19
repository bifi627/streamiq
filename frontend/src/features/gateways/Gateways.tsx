import { useEffect, useState } from 'react'
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
import { deletePin } from '../pairing/store'
import { renameMessage, toAppError, type AppError } from '../../errors'
import { ErrorView, State } from '../../ErrorView'
import { copyText } from '../../clipboard'
import { Link, useNavigate } from '@tanstack/react-router'
import { useHousehold } from '../households/household'
import { arrowFocus } from '../../focus'
import { EditableName, STORED } from './EditableName'
import { UpdateNotice } from './UpdateNotice'
import { StatusDetails } from './StatusDetails'
import { PairedClients } from './PairedClients'
import { canManage, shownError, withId, type ActErr } from './list'

// `/` (#225): straight into the library when the household has exactly one
// gateway, else the list. History replace both ways, so Back doesn't bounce.
export function Home() {
  const navigate = useNavigate()
  const { data, isError } = useGateways()
  useEffect(() => {
    if (!data && !isError) return // the list shows the error
    if (data?.length === 1)
      navigate({
        to: '/g/$gatewayId',
        params: { gatewayId: data[0].id },
        replace: true,
      })
    else navigate({ to: '/gateways', replace: true })
  }, [data, isError, navigate])
  return null
}

// Gateways list + "Add gateway" (onboarding flow 1). Polls so a freshly installed
// gateway shows up, and online/offline stays current. ponytail: 5s poll, push
// updates over a socket if the list ever gets big. Add/Remove are admin-only
// (#190): hidden for a member (the API answers 403 anyway) and until /me is in;
// a member gets told an admin does them instead (#211).
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
  // Gateways this browser holds a pin for: Rename goes over the tunnel, so it
  // shows only there (#329). Each card's Pairing reports it (onPin, onPaired).
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set())
  const pin = (id: string, p: boolean) => setPinned((s) => withId(s, id, p))
  // Gateways this browser removed itself from (#311): Pair shows again.
  const [unpaired, setUnpaired] = useState<ReadonlySet<string>>(new Set())
  async function removedSelf(id: string) {
    await deletePin(id).catch(() => {}) // a stale pin would only fail later
    dropShared(id) // the gateway closed it anyway
    pin(id, false)
    setUnpaired((s) => withId(s, id, true))
  }

  function remove(d: Gateway) {
    if (
      !confirm(
        `Remove "${d.name ?? 'gateway'}"? It disconnects now and must be installed again to come back.`,
      )
    )
      return
    removing.mutate(d.id)
  }

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
      <div className="head">
        <h1>Gateways</h1>
        {/* No gateways: the empty state carries it instead. */}
        {admin && gateways?.length !== 0 && (
          <button type="button" className="no-tv" onClick={addGateway}>
            Add gateway
          </button>
        )}
      </div>
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
              manage={canManage(admin, d.online, pinned.has(d.id))}
              unpaired={unpaired.has(d.id)}
              onPin={(p) => pin(d.id, p)}
              onPaired={() => {
                pin(d.id, true)
                setUnpaired((s) => withId(s, d.id, false))
              }}
              onRename={(n) => rename(d, n)}
              onRemove={() => remove(d)}
              onRemovedSelf={() => removedSelf(d.id)}
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

// One gateway's card. manage: Rename and Update over the tunnel (canManage).
// oxlint-disable-next-line complexity -- render branching
function GatewayCard({
  g,
  admin,
  manage,
  unpaired,
  onPin,
  onPaired,
  onRename,
  onRemove,
  onRemovedSelf,
}: {
  g: Gateway
  admin: boolean
  manage: boolean
  unpaired: boolean
  onPin: (pinned: boolean) => void
  onPaired: () => void
  onRename: (name: string) => Promise<string | null>
  onRemove: () => void
  onRemovedSelf: () => void
}) {
  const navigate = useNavigate()
  return (
    <li className="card" data-gateway={g.id}>
      <div className="card-head">
        <EditableName
          name={g.name ?? 'gateway'}
          label="Gateway name"
          hint={STORED}
          rename={manage ? onRename : undefined}
        />
        <span className="chip">
          <span className={g.online ? 'dot online' : 'dot'} />
          {g.online ? 'Online' : 'Offline'}
        </span>
      </div>
      {g.version && <span className="meta muted">Version {g.version}</span>}
      {g.upgradeRequired ? (
        <p className="notice">
          Update required: rerun the install command on the gateway.
        </p>
      ) : (
        <UpdateNotice g={g} canUpdate={manage} />
      )}
      {g.online ? (
        // Pair this browser stands where Open is until it's paired (#226).
        <Pairing
          gatewayId={g.id}
          lanUrl={g.lanUrl}
          needsPair={unpaired}
          onPin={onPin}
          onPaired={onPaired}
          open={() =>
            navigate({ to: '/g/$gatewayId', params: { gatewayId: g.id } })
          }
        >
          {/* Every device (#248); the library shows it only in TV mode. */}
          {!unpaired && (
            <Link to="/g/$gatewayId/screen" params={{ gatewayId: g.id }}>
              Use as screen
            </Link>
          )}
          {g.lanUrl && (
            <a href={g.lanUrl} target="_blank" rel="noreferrer">
              Gateway page
            </a>
          )}
          {admin && <RemoveButton onClick={onRemove} />}
        </Pairing>
      ) : (
        admin && (
          <div className="actions">
            <RemoveButton onClick={onRemove} />
          </div>
        )
      )}
      <StatusDetails g={g} />
      {/* A member's list is just this browser (#341). */}
      <PairedClients g={g} unpaired={unpaired} onRemovedSelf={onRemovedSelf} />
    </li>
  )
}

const RemoveButton = ({ onClick }: { onClick: () => void }) => (
  <button type="button" className="end" onClick={onClick}>
    Remove
  </button>
)
