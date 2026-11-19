import { useEffect, useRef, useState, type ReactNode } from 'react'
import { browserName, connect } from './connect'
import { clientKey, getPin } from './store'
import { AppError, renameMessage, toAppError } from '../../errors'
import { listClients, renameClient } from '../gateways/api'
import { isBack } from '../library/items'
import { systemInfo, type SystemInfo } from '../library/jellyfin'
import { ErrorView } from '../../ErrorView'
import { tunnelJson } from '../../tunnel'
import { pairInfo, type PairInfo } from '../../stats'
import { arrowFocus } from '../../focus'

type State =
  | { step: 'idle' }
  | { step: 'connecting'; pair: boolean }
  | { step: 'code'; code: string }
  | { step: 'done'; paired: boolean; info: SystemInfo; path: PairInfo | null }
  | { step: 'failed'; err: AppError }

// Pair this browser with an online gateway (flow 2), or open a pinned connection
// and tunnel one request through it ("Test connection": a cheap diagnostic).
// oxlint-disable-next-line complexity, max-lines-per-function -- render branching + effect wiring; length: #607
export function Pairing({
  gatewayId,
  lanUrl,
  needsPair,
  onPaired,
  onPin,
  open,
  children,
}: {
  gatewayId: string
  lanUrl: string | null
  /** The caller already knows the pin is no good (library error): always offer Pair. */
  needsPair?: boolean
  /** After a successful pairing (not after Test connection). */
  onPaired?: () => void
  /** Whether this browser has a stored pin for the gateway, read on mount. A
   * failed test doesn't call it again: the pin stays stored (#329). */
  onPin?: (pinned: boolean) => void
  /** Gateway card (#226): Open takes Pair's place once this browser is paired. */
  open?: () => void
  /** With open: more actions in Open's row (Test connection goes below). */
  children?: ReactNode
}) {
  const [s, setS] = useState<State>({ step: 'idle' })
  // Pair shows while this browser has no pin for the gateway. ponytail: a pin
  // the gateway dropped (Remove on its page) only shows on a failed test.
  const [pinned, setPinned] = useState<boolean | null>(null)
  useEffect(() => {
    const got = (p: boolean) => {
      setPinned(p)
      onPin?.(p)
    }
    getPin(gatewayId).then(
      (p) => got(!!p),
      () => got(false),
    )
  }, [gatewayId])

  const root = useRef<HTMLDivElement>(null)
  const testBtn = useRef<HTMLButtonElement>(null)
  // A run can unmount the focused control (Pair once refused, the error's
  // Retry): focus then falls to <body>, outside every D-pad container. Put it
  // on Test connection, which always renders (#226). Only for a run started
  // from inside the block, and only on its state changes: never on the
  // Gateways list's 5 s poll renders.
  const keep = useRef(false)
  useEffect(() => {
    const lost =
      !document.activeElement || document.activeElement === document.body
    if (keep.current && lost) testBtn.current?.focus()
    if (s.step === 'done' || s.step === 'failed') keep.current = false
  }, [s])
  const busy = s.step === 'connecting' || s.step === 'code'
  async function run(pair: boolean) {
    if (busy) return
    keep.current = !!root.current?.contains(document.activeElement)
    setS({ step: 'connecting', pair })
    try {
      const x = await connect(
        gatewayId,
        pair ? (code) => setS({ step: 'code', code }) : undefined,
      )
      if (pair) setPinned(true)
      try {
        const [info, stats] = await Promise.all([
          tunnelJson<SystemInfo>(x.pc, systemInfo),
          x.pc.getStats(),
        ])
        setS({ step: 'done', paired: pair, info, path: pairInfo(stats) })
      } finally {
        x.close()
        if (pair) onPaired?.() // paired even if the test request failed
      }
    } catch (e) {
      const err = toAppError(e)
      // No usable pin: Pair stays, not Open, through a retest or a refused pairing.
      if (err.kind === 'not-paired' || err.kind === 'pin-mismatch')
        setPinned(false)
      setS({ step: 'failed', err })
    }
  }

  const err = s.step === 'failed' ? s.err : null
  const showPair =
    needsPair ||
    pinned === false ||
    err?.kind === 'not-paired' ||
    err?.kind === 'pin-mismatch' ||
    (s.step === 'connecting' && s.pair) || // stays put while it runs
    s.step === 'code'
  const gatewayPage = lanUrl ? (
    <a href={lanUrl} target="_blank" rel="noreferrer">
      gateway page
    </a>
  ) : (
    'gateway page'
  )

  const test = (
    <button
      ref={testBtn}
      type="button"
      aria-disabled={busy}
      onClick={() => run(false)}
    >
      Test connection
    </button>
  )

  return (
    // arrowFocus here too: an arrow moves within the pairing block first; the
    // page's container (library, Gateways) takes it from there.
    <div className="pairing" ref={root} onKeyDown={arrowFocus}>
      <div className="actions">
        {/* One element for both: React keeps the DOM node, so focus stays put
            when Pair turns into Open. */}
        {(showPair || open) && (
          <button
            type="button"
            className="primary"
            aria-disabled={showPair && busy}
            onClick={showPair ? () => run(true) : open}
          >
            {showPair ? 'Pair this browser' : 'Open'}
          </button>
        )}
        {open ? children : test}
      </div>
      {/* The card's row is full (Gateway page, Remove): Test goes below. */}
      {open && <div className="actions">{test}</div>}
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
              {!s.path ? 'unknown' : s.path.relay ? 'relayed (TURN)' : 'direct'}
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
      {s.step === 'done' && s.paired && (
        // Closing it unmounts the focused control: keep the D-pad's place (#226).
        <NamePrompt
          gatewayId={gatewayId}
          onDone={() => testBtn.current?.focus()}
        />
      )}
      {err && <ErrorView error={err} onRetry={() => run(false)} pair={null} />}
    </div>
  )
}

// Once, right after pairing (#365): name this client, prefilled with the name it
// paired with (shown only while that is still the auto name). Skip keeps that name; renaming later is on the gateway's Paired
// clients list. The gateway owns the name: POST /streamiq/clients/rename.
function NamePrompt({
  gatewayId,
  onDone,
}: {
  gatewayId: string
  onDone: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null) // null = no prompt
  const [error, setError] = useState<string | null>(null)
  // Only while the gateway still holds the auto name: a re-pair of a client
  // the user already named (pin mismatch, new gateway cert) keeps that name.
  useEffect(() => {
    listClients(gatewayId).then(
      (l) => {
        const me = l.find((c) => c.self)
        if (me?.name === browserName()) setDraft(me.name)
      },
      () => {}, // no prompt; Rename on the Paired clients list still works
    )
  }, [gatewayId])
  const done = () => {
    onDone() // while the form still has focus to give away
    setDraft(null)
  }
  if (draft === null) return null
  return (
    <form
      className="name-prompt"
      onSubmit={async (e) => {
        e.preventDefault()
        try {
          await renameClient(gatewayId, (await clientKey()).fp, draft.trim())
          done()
        } catch (x) {
          setError(renameMessage(toAppError(x)))
        }
      }}
      onKeyDown={(e) => {
        if (!isBack(e.nativeEvent)) return
        e.preventDefault() // else the browser's own Back runs too (webOS remote)
        done()
      }}
    >
      <label>
        Name this browser
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
          maxLength={100}
          required
          pattern=".*\S.*"
          placeholder="e.g. Living room TV"
        />
      </label>
      <div className="actions">
        <button type="submit" className="primary">
          Save
        </button>
        <button type="button" onClick={done}>
          Skip
        </button>
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}
