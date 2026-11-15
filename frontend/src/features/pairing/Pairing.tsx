import { useEffect, useState } from 'react'
import { connect } from './connect'
import { getPin } from './store'
import { AppError, toAppError } from '../../errors'
import { ErrorView } from '../../ErrorView'
import { tunnelJson } from '../../tunnel'
import { pairInfo, type PairInfo } from '../../stats'
import { arrowFocus } from '../../focus'

type Info = { ServerName?: string; Version?: string; ProductName?: string }
type State =
  | { step: 'idle' }
  | { step: 'connecting'; pair: boolean }
  | { step: 'code'; code: string }
  | { step: 'done'; paired: boolean; info: Info; path: PairInfo | null }
  | { step: 'failed'; err: AppError }

// Pair this browser with an online gateway (flow 2), or open a pinned connection
// and tunnel one request through it ("Test connection": a cheap diagnostic).
export function Pairing({
  gatewayId,
  lanUrl,
  needsPair,
  onPaired,
}: {
  gatewayId: string
  lanUrl: string | null
  /** The caller already knows the pin is no good (library error): always offer Pair. */
  needsPair?: boolean
  /** After a successful pairing (not after Test connection). */
  onPaired?: () => void
}) {
  const [s, setS] = useState<State>({ step: 'idle' })
  // Pair shows while this browser has no pin for the gateway. ponytail: a pin
  // the gateway dropped (Remove on its page) only shows on a failed test.
  const [pinned, setPinned] = useState<boolean | null>(null)
  useEffect(() => {
    getPin(gatewayId).then(
      (p) => setPinned(!!p),
      () => setPinned(false),
    )
  }, [gatewayId])

  const busy = s.step === 'connecting' || s.step === 'code'
  async function run(pair: boolean) {
    if (busy) return
    setS({ step: 'connecting', pair })
    try {
      const x = await connect(
        gatewayId,
        pair ? (code) => setS({ step: 'code', code }) : undefined,
      )
      if (pair) setPinned(true)
      try {
        const [info, stats] = await Promise.all([
          tunnelJson<Info>(x.pc, '/System/Info/Public'),
          x.pc.getStats(),
        ])
        setS({ step: 'done', paired: pair, info, path: pairInfo(stats) })
      } finally {
        x.close()
      }
      if (pair) onPaired?.()
    } catch (e) {
      setS({ step: 'failed', err: toAppError(e) })
    }
  }

  const err = s.step === 'failed' ? s.err : null
  const showPair =
    needsPair ||
    pinned === false ||
    err?.kind === 'not-paired' ||
    err?.kind === 'pin-mismatch'
  const gatewayPage = lanUrl ? (
    <a href={lanUrl} target="_blank" rel="noreferrer">
      gateway page
    </a>
  ) : (
    'gateway page'
  )

  return (
    // arrowFocus here too: in the library it renders outside any D-pad container.
    <div className="pairing" onKeyDown={arrowFocus}>
      <div className="actions">
        {showPair && (
          <button
            type="button"
            className="primary"
            aria-disabled={busy}
            onClick={() => run(true)}
          >
            Pair this browser
          </button>
        )}
        <button type="button" aria-disabled={busy} onClick={() => run(false)}>
          Test connection
        </button>
      </div>
      {s.step === 'connecting' && (
        <p className="pair-state" role="status">
          <span className="dot" />
          {s.pair ? 'Connecting to start pairing…' : 'Testing the connection…'}
        </p>
      )}
      {s.step === 'code' && (
        <div className="pair-box" role="status">
          <p className="pair-state">
            <span className="dot waiting" />
            Waiting for approval
          </p>
          <output className="pair-code" aria-label="Comparison code">
            {s.code}
          </output>
          <p>
            Open the {gatewayPage} on your home network and approve the request
            showing this code.
          </p>
        </div>
      )}
      {s.step === 'done' && (
        <div className="pair-box ok" role="status">
          <p className="pair-state">
            <span className="dot online" />
            {s.paired ? 'Paired · tunnel OK' : 'Tunnel OK'}
          </p>
          <dl className="facts">
            <dt>Route</dt>
            <dd>
              {!s.path
                ? 'unknown'
                : s.path.relay
                  ? 'relayed (TURN)'
                  : 'direct'}
              {s.path?.rttMs !== undefined &&
                ` · ${s.path.rttMs.toLocaleString()} ms round trip`}
            </dd>
            <dt>{s.info.ProductName ?? 'Media server'}</dt>
            <dd>{s.info.ServerName ?? 'unnamed'}</dd>
            <dt>Version</dt>
            <dd>{s.info.Version ?? 'unknown'}</dd>
          </dl>
        </div>
      )}
      {err && <ErrorView error={err} onRetry={() => run(false)} pair={null} />}
    </div>
  )
}
