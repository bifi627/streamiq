// /diagnostics: what this client can play, and how good its path to a
// gateway is, as a report to paste into a support request. No email, no IPs.
import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  diag,
  relayOn,
  relayForced,
  relayTlsOn,
  setFlag,
  setRelay,
  snapshot,
  subscribe,
} from '../../shared/diag'
import { copyText } from '../../shared/clipboard'
import { pairInfo, pathLine } from '../../shared/stats'
import { dataSaverOn } from '../../shared/settings'
import { connect } from '../pairing/connect'
import { isKind } from '../../shared/errors'
import { useGateways } from '../gateways/api'
import { describe, probe } from '../player/profile'
import { useHousehold } from '../households/household'
import {
  defaultGateway,
  gatewayLabel,
  report as reportText,
  throughputLine,
  type Test,
} from './report'
import { noop } from '../../shared/noop'

export function DiagnosticsPage() {
  useSyncExternalStore(subscribe, snapshot) // Force relay checkbox, cpu/memory lines
  const [caps, setCaps] = useState('probing…')
  const gateways = useGateways().data ?? []
  const [picked, setGatewayId] = useState('')
  const gatewayId = picked || defaultGateway(gateways)
  const [test, setTest] = useState<Test | null>(null)
  const [running, setRunning] = useState(false)
  const [copied, setCopied] = useState('')
  const { me } = useHousehold()

  useEffect(() => {
    probe()
      .then((p) => setCaps(describe(p)))
      .catch((e) =>
        setCaps(`probe failed: ${e instanceof Error ? e.message : e}`),
      )
  }, [])

  async function run() {
    setRunning(true)
    const lines = [
      `tested: ${new Date().toLocaleString()}`,
      `relay forced: ${relayForced()}`,
    ]
    const show = (failed?: string) => setTest({ lines: [...lines], failed })
    show()
    let step = 'connect (broker → ICE → gateway auth)'
    let close = noop
    diag.relay = ''
    // The broker's `ready` sets diag.relay, also when connect fails after it.
    const relay = () => diag.relay && lines.push(diag.relay)
    try {
      const s = await connect(gatewayId).catch((e) => {
        relay()
        if (isKind(e, 'not-paired')) lines.push('paired: no')
        throw e
      })
      close = s.close
      relay()
      lines.push('paired: yes')
      show()
      step = 'path stats'
      lines.push(pathLine(pairInfo(await s.pc.getStats())))
      show()
      step = 'throughput (gateway bursts)'
      const speed = s.speed() // fresh: ignores the cache and the setting
      await Promise.race([
        speed.test(),
        new Promise((r) => setTimeout(r, 60_000)),
      ])
      const mbps = speed.fresh()
      if (!mbps) throw new Error(speed.error() ?? 'timed out')
      lines.push(throughputLine(mbps, dataSaverOn()))
      show()
    } catch (e) {
      show(
        `failed at ${step}: ${e instanceof Error ? e.message : e} (peer: ${diag.pc || 'none'})`,
      )
    } finally {
      close() // ends the session: the gateway records the tunnel
      setRunning(false)
    }
  }

  const gw = gateways.find((g) => g.id === gatewayId)
  const report = reportText({
    cpu: diag.cpu,
    memory: diag.memory,
    lastRun: diag.lastRun,
    browser: navigator.userAgent,
    screen: `${screen.width}x${screen.height} @${devicePixelRatio}x, window ${innerWidth}x${innerHeight}`,
    caps,
    test,
    gatewayId,
    gw,
  })

  const copy = async () =>
    setCopied(
      (await copyText(report))
        ? 'Copied.'
        : 'Copy blocked: select the text below instead.', // insecure origin / old TV
    )

  // The tokens' page layout: Settings' column of cards (.settings).
  return (
    <section className="settings diagnostics">
      <div className="head">
        <h1>Diagnostics</h1>
        <p className="muted">
          What this browser can play and how it reaches your gateway, as a
          report for a support request. No email, no IPs.
        </p>
        <p className="muted meta">tenant {me?.tenantId}</p>
      </div>

      <div className="card">
        <h2>Connection test</h2>
        <div className="actions">
          {gateways.length > 1 ? (
            // ponytail: a <select> keeps the D-pad's arrows (focus.ts), so
            // only when there is a choice to make.
            <label>
              Gateway{' '}
              <select
                value={gatewayId}
                onChange={(e) => setGatewayId(e.target.value)}
              >
                {gateways.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name ?? g.id} {g.online ? '' : '(offline)'}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span>Gateway: {gatewayLabel(gw)}</span>
          )}
          <button
            type="button"
            className="primary"
            autoFocus
            // busy, but keeps focus: a disabled button drops the D-pad's place
            aria-disabled={!gatewayId || running}
            onClick={() => gatewayId && !running && run()}
          >
            {running ? 'Testing…' : 'Test connection'}
          </button>
          <label>
            <input
              type="checkbox"
              checked={relayOn()}
              onChange={(e) => setRelay(e.target.checked)}
            />{' '}
            Force relay (TURN)
          </label>
          <label>
            <input
              type="checkbox"
              checked={relayTlsOn()}
              onChange={(e) => setFlag('relayTls', e.target.checked)}
            />{' '}
            Force relay over TLS (443)
          </label>
        </div>
      </div>

      <div className="card">
        <h2>Report</h2>
        {/* left, under the heading: the D-pad's Down from the test reaches it */}
        <button type="button" onClick={copy}>
          Copy report
        </button>
        {copied && <p role="status">{copied}</p>}
        <pre className="report">{report}</pre>
      </div>
    </section>
  )
}
