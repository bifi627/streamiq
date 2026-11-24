import { useEffect, useState, useSyncExternalStore } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { PageBar } from '../../shared/PageBar'
import { createEnrollmentToken, type Install, useGateways } from './api'
import { toAppError, type AppError } from '../../shared/errors'
import { ErrorView, State } from '../../shared/ErrorView'
import { copyText } from '../../shared/clipboard'
import { Dialog } from '../../shared/Dialog'
import { useHousehold } from '../households/household'
import { arrowFocus } from '../../shared/focus'
import { lastGateway, onLastGateway } from '../../shared/settings'
import { libraryTarget } from '../../shell'
import { activeFirst, shownError, type ActErr } from './list'
import { OverviewCard } from './OverviewCard'

// `/`: straight into the active gateway's library, the list without a
// gateway. History replace both ways, so Back doesn't bounce.
export function Home() {
  const navigate = useNavigate()
  const { data, isError } = useGateways()
  useEffect(() => {
    if (!data && !isError) return // the list shows the error
    const id = data && libraryTarget(undefined, lastGateway(), data)
    if (id)
      navigate({
        to: '/g/$gatewayId',
        params: { gatewayId: id },
        replace: true,
      })
    else navigate({ to: '/gateways', replace: true })
  }, [data, isError, navigate])
  return null
}

// The gateways overview: a card per gateway, the active one first, and "Add
// gateway" (onboarding flow 1). Polls so a freshly installed gateway shows up,
// and online/offline stays current. ponytail: 5s poll, push updates over a
// socket if the list ever gets big. Add is admin-only: hidden for a member (the
// API answers 403 anyway) and until /me is in; a member gets told an admin
// does it instead.
// oxlint-disable-next-line complexity -- render branching
export function Gateways() {
  const q = useGateways(5000)
  const qc = useQueryClient()
  const gateways = q.data ?? null // null = loading
  const last = useSyncExternalStore(onLastGateway, lastGateway)
  const active = libraryTarget(undefined, last, gateways ?? [])
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
            <button
              type="button"
              className="icon-btn no-tv"
              aria-label="Add gateway"
              title="Add gateway"
              onClick={addGateway}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          )
        }
      />
      {err && <ErrorView error={err} />}
      {install && (
        <Dialog title="Add a gateway" onClose={() => setInstall(null)}>
          {/* Keyed by the command (it holds the token): a new token resets Copied. */}
          <InstallCard key={install.installCommand} install={install} />
        </Dialog>
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
          {activeFirst(gateways, active).map((g) => (
            <OverviewCard key={g.id} g={g} active={g.id === active} />
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
    <div className="install no-tv">
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
