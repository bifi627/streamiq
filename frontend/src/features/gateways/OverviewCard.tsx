import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { probe, type Gateway } from './api'
import { connKey, type Conn, type Route } from './connection'
import { dotLabel, dotOf, gatewayName } from './list'
import { usePin } from '../pairing/store'
import { PairDialog } from './PairDialog'
import { pinUnusable } from '../pairing/pairState'
import { RouteBadge } from '../player/Privacy'
import { ErrorView } from '../../shared/ErrorView'
import { toAppError, type AppError } from '../../shared/errors'
import { setLastGateway } from '../../shared/settings'

type Test = 'testing' | { route: Route } | { err: AppError } | null

// One gateway on the overview: status, Active / Switch / Pair, Test. The name
// is a link stretched over the card (CSS), the buttons sit above it: a click
// outside them opens the gateway's page, with no button inside a link.
export function OverviewCard({ g, active }: { g: Gateway; active: boolean }) {
  const qc = useQueryClient()
  const [pinned, setPinned] = usePin(g.id)
  const [pairing, setPairing] = useState(false)
  const [test, setTest] = useState<Test>(null)
  const dot = dotOf(g)

  // Today's connection test (one tunnel); its answer also feeds the shell
  // badge, which shows this gateway once it is the active one.
  async function runTest() {
    if (test === 'testing') return
    setTest('testing')
    const feed = (c: Conn) => qc.setQueryData(connKey(g.id), c)
    try {
      const route = await probe(g.id, !!g.relayOff)
      feed({ route })
      setTest({ route })
    } catch (e) {
      const err = toAppError(e)
      // No usable pin: Pair takes Test's place, as on the Pairing block.
      if (pinUnusable(err)) setPinned(false)
      // Offline: the badge shows that itself; a failed check would stick.
      if (g.online) feed({ route: 'failed' })
      setTest({ err })
    }
  }

  return (
    <li className={active ? 'card gw active' : 'card gw'} data-gateway={g.id}>
      <div className="gw-head">
        <span
          className={`dot ${dot}`}
          role="img"
          aria-label={dotLabel[dot]}
          title={dotLabel[dot]}
        />
        <Link className="gw-link" to="/gateways/$id" params={{ id: g.id }}>
          {gatewayName(g)}
        </Link>
      </div>
      {g.version && <span className="meta muted">Version {g.version}</span>}
      {g.upgradeRequired && (
        <p className="notice">
          Update required: rerun the install command on the gateway.
        </p>
      )}
      <div className="actions">
        {active ? (
          <span className="chip active-chip">Active</span>
        ) : (
          pinned !== false && (
            <button type="button" onClick={() => setLastGateway(g.id)}>
              Switch
            </button>
          )
        )}
        {pinned === false ? (
          <button
            type="button"
            className="primary"
            disabled={!g.online} // pairing needs the gateway
            onClick={() => setPairing(true)}
          >
            Pair
          </button>
        ) : (
          <button
            type="button"
            aria-disabled={test === 'testing'}
            onClick={runTest}
          >
            Test
          </button>
        )}
      </div>
      <TestResult test={test} retry={runTest} />
      {pairing && (
        <PairDialog
          g={g}
          onClose={() => setPairing(false)}
          onPaired={() => {
            setPinned(true)
            setTest(null) // an earlier refusal is moot
          }}
        />
      )}
    </li>
  )
}

function TestResult({ test, retry }: { test: Test; retry: () => void }) {
  if (!test) return null
  if (test === 'testing')
    return (
      <p className="pair-state" role="status">
        <span className="dot" />
        Testing the connection…
      </p>
    )
  if ('err' in test)
    return <ErrorView error={test.err} onRetry={retry} pair={null} />
  return (
    <p className="gw-test" role="status">
      <RouteBadge route={test.route} />
    </p>
  )
}
