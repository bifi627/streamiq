import { useEffect, useRef, useState } from 'react'
import { browserName, connect, type Confirm } from './connect'
import { clientKey, usePin } from './store'
import { renameMessage, toAppError } from '../../shared/errors'
import { listClients, renameClient } from '../gateways/api'
import { isBack } from '../library/items'
import { systemInfo, type SystemInfo } from '../library/jellyfin'
import { ErrorView } from '../../shared/ErrorView'
import { tunnelJson } from '../../shared/tunnel'
import { pairInfo } from '../../shared/stats'
import { arrowFocus } from '../../shared/focus'
import { tvOn } from '../../shared/settings'
import {
  pinUnusable,
  routeLine,
  showPair as pairShown,
  type State,
} from './pairState'
import { event } from '../../shared/diag'
import { useQueryClient } from '@tanstack/react-query'
import { connKey } from '../gateways/connection'

// Pair this browser with an online gateway (flow 2), or open a pinned connection
// and tunnel one request through it ("Test connection": a cheap diagnostic).
export function Pairing({
  gatewayId,
  lanUrl,
  needsPair,
  autoPair,
  onPaired,
}: {
  gatewayId: string
  lanUrl: string | null
  /** The caller already knows the pin is no good (library error): always offer Pair. */
  needsPair?: boolean
  /** Starts pairing on mount (PairDialog). */
  autoPair?: boolean
  /** After a successful pairing (not after Test connection). */
  onPaired?: () => void
}) {
  const [s, setS] = useState<State>({ step: 'idle' })
  // Pair shows while this browser has no pin for the gateway. ponytail: a pin
  // the gateway dropped (Remove on its page) only shows on a failed test.
  const [pinned, setPinned] = usePin(gatewayId)
  const qc = useQueryClient()

  const root = useRef<HTMLDivElement>(null)
  const testBtn = useRef<HTMLButtonElement>(null)
  // A run can unmount the focused control (Pair once refused, the error's
  // Retry): focus then falls to <body>, outside every D-pad container. Put it
  // on Test connection, which always renders. Only for a run started
  // from inside the block, and only on its state changes: never on the
  // Gateways list's 5 s poll renders.
  const keep = useRef(false)
  useEffect(() => {
    const lost =
      !document.activeElement || document.activeElement === document.body
    if (keep.current && lost) testBtn.current?.focus()
    if (s.step === 'done' || s.step === 'failed') keep.current = false
  }, [s])
  // Leaving the page ends a running attempt: the gateway frees the pairing slot
  // now, not after its 5-minute expiry.
  const attempt = useRef<AbortController>(undefined)
  const confirm = useRef<Confirm>(undefined)
  useEffect(() => () => attempt.current?.abort(), [])
  // A tick later: dev's StrictMode mounts twice, and the abort above would
  // end the first attempt (its slot freed only later: "busy").
  useEffect(() => {
    if (!autoPair) return
    const t = setTimeout(() => void run(true))
    return () => clearTimeout(t)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, [])
  const busy = s.step === 'connecting' || s.step === 'code'
  async function run(pair: boolean) {
    if (busy) return
    keep.current = !!root.current?.contains(document.activeElement)
    setS({ step: 'connecting', pair })
    attempt.current = new AbortController()
    try {
      const x = await connect(
        gatewayId,
        pair
          ? (code, c) => {
              confirm.current = c
              setS({ step: 'code', code, matched: false })
            }
          : undefined,
        attempt.current.signal,
      )
      if (pair) {
        setPinned(true)
        // The shell badge's check ran unpaired: check again.
        void qc.invalidateQueries({ queryKey: connKey(gatewayId) })
      }
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
      // No usable pin: Pair stays through a retest or a refused pairing.
      if (pinUnusable(err)) setPinned(false)
      setS({ step: 'failed', err })
    }
  }

  const err = s.step === 'failed' ? s.err : null
  const showPair = pairShown(s, pinned, needsPair)

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
        {test}
      </div>
      {s.step === 'connecting' && (
        <p className="pair-state" role="status">
          <span className="dot" />
          {s.pair ? 'Connecting to start pairing…' : 'Testing the connection…'}
        </p>
      )}
      {s.step === 'code' && (
        <PairCode
          code={s.code}
          matched={s.matched}
          lanUrl={lanUrl}
          onAnswer={(ok) => {
            confirm.current?.(ok)
            if (ok) setS({ ...s, matched: true })
          }}
        />
      )}
      {s.step === 'done' && <TunnelOk s={s} />}
      {s.step === 'done' && s.paired && (
        // Closing it unmounts the focused control: keep the D-pad's place.
        <NamePrompt
          gatewayId={gatewayId}
          onDone={() => testBtn.current?.focus()}
        />
      )}
      {err && <ErrorView error={err} onRetry={() => run(false)} pair={null} />}
    </div>
  )
}

// Pairing waits for both sides: the user compares the code here, and approves
// it on the local gateway page. A TV names that page's URL as text: the phone
// or PC at home opens it, not the TV's browser.
function PairCode({
  code,
  matched,
  lanUrl,
  onAnswer,
}: {
  code: string
  matched: boolean
  lanUrl: string | null
  onAnswer: (matches: boolean) => void
}) {
  const gatewayPage = !lanUrl ? (
    'gateway page'
  ) : tvOn() ? (
    `gateway page (${lanUrl})`
  ) : (
    <a href={lanUrl} target="_blank" rel="noreferrer">
      gateway page
    </a>
  )
  return (
    <div className="pair-box" role="status">
      <p className="pair-state">
        <span className="dot waiting" />
        Waiting for approval
      </p>
      <output className="pair-code" aria-label="Comparison code">
        {code}
      </output>
      <p>
        Open the {gatewayPage} on your home network and approve the request
        showing this code.
      </p>
      {!matched && (
        <>
          <p>Does the gateway show this code?</p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={() => onAnswer(true)}
            >
              It matches
            </button>
            <button type="button" onClick={() => onAnswer(false)}>
              It doesn't
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// A passed run: the tunnel's route and the media server that answered.
function TunnelOk({ s }: { s: Extract<State, { step: 'done' }> }) {
  return (
    <div className="pair-box ok" role="status">
      <p className="pair-state">
        <span className="dot online" />
        {s.paired ? 'Paired · tunnel OK' : 'Tunnel OK'}
      </p>
      <dl className="facts">
        <dt>Route</dt>
        <dd>{routeLine(s.path)}</dd>
        <dt>{s.info.ProductName ?? 'Media server'}</dt>
        <dd>{s.info.ServerName ?? 'unnamed'}</dd>
        <dt>Version</dt>
        <dd>{s.info.Version ?? 'unknown'}</dd>
      </dl>
    </div>
  )
}

// Once, right after pairing: name this client, prefilled with the name it
// paired with (shown only while that is still the auto name). Skip keeps that
// name; a later rename is on the gateway's Paired clients list. The gateway
// owns the name: POST /streamiq/clients/rename.
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
      // no prompt; Rename on the Paired clients list still works
      (e) => event(`pairing: own client name failed: ${e}`),
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
