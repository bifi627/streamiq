// /diagnostics (#90): what this client can play, and how good its path to a
// gateway is, as a report to paste into a support request. No email, no IPs.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { diag, relayOn, setFlag, snapshot, subscribe } from '../../diag'
import { pairInfo } from '../../stats'
import { dataSaverOn } from '../../settings'
import { connect } from '../pairing/connect'
import { isKind } from '../../errors'
import { getGateways, type Gateway } from '../gateways/api'
import { describe, probe } from '../library/profile'
import { useHousehold } from '../households/household'

type Test = { lines: string[]; failed?: string }

export function DiagnosticsPage() {
  useSyncExternalStore(subscribe, snapshot) // Force relay checkbox, cpu/memory lines
  const [caps, setCaps] = useState('probing…')
  const [gateways, setGateways] = useState<Gateway[]>([])
  const [gatewayId, setGatewayId] = useState('')
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
    getGateways()
      .then((gs) => {
        setGateways(gs)
        setGatewayId((gs.find((g) => g.online) ?? gs[0])?.id ?? '')
      })
      .catch(() => {})
  }, [])

  async function run() {
    setRunning(true)
    const lines = [
      `tested: ${new Date().toLocaleString()}`,
      `relay forced: ${relayOn() ? 'yes' : 'no'}`,
    ]
    const show = (failed?: string) => setTest({ lines: [...lines], failed })
    show()
    let step = 'connect (broker → ICE → gateway auth)'
    let close = () => {}
    try {
      const s = await connect(gatewayId).catch((e) => {
        if (isKind(e, 'not-paired')) lines.push('paired: no')
        throw e
      })
      close = s.close
      lines.push('paired: yes')
      show()
      step = 'path stats'
      const p = pairInfo(await s.pc.getStats())
      lines.push(
        p
          ? `path: ${p.relay ? 'relayed (TURN)' : 'direct'} · ${p.ipv6 ? 'IPv6' : 'IPv4'} · ${p.protocol ?? '?'} · ${p.local ?? '?'} → ${p.remote ?? '?'} · RTT ${p.rttMs ?? '?'} ms`
          : 'path: no selected candidate pair',
      )
      show()
      step = 'throughput (gateway bursts)'
      const speed = s.speed() // the session's own measurement (speed.ts)
      await speed.get(60_000)
      const mbps = speed.fresh()
      if (!mbps) throw new Error(speed.error() ?? 'timed out')
      lines.push(
        `throughput: ${mbps.toFixed(1)} Mbps (median of ${dataSaverOn() ? '3 × 1 MiB bursts, data saver on' : '3 ~2 s bursts after a warm-up'}; Auto caps at ${(mbps * 0.7).toFixed(1)} Mbps)`,
      )
      show()
    } catch (e) {
      show(
        `failed at ${step}: ${e instanceof Error ? e.message : e} (peer: ${diag.pc || 'none'})`,
      )
    } finally {
      close() // ends the session and its telemetry row
      setRunning(false)
    }
  }

  const gw = gateways.find((g) => g.id === gatewayId)
  const report = [
    'StreamIQ diagnostics',
    `browser: ${navigator.userAgent}`,
    `screen: ${screen.width}x${screen.height} @${devicePixelRatio}x, window ${innerWidth}x${innerHeight}`,
    `codecs: ${caps}`,
    ...(diag.cpu ? [`cpu: ${diag.cpu}`] : []),
    ...(diag.memory ? [`memory: ${diag.memory}`] : []),
    ...(diag.lastRun ? [diag.lastRun] : []),
    ...(test
      ? [
          `gateway: ${gw?.name ?? gatewayId} (${gw?.version ?? '?'})`,
          ...test.lines,
          ...(test.failed ? [test.failed] : []),
        ]
      : ['connection test: not run']),
  ].join('\n')

  async function copy() {
    try {
      await navigator.clipboard.writeText(report)
      setCopied('Copied.')
    } catch {
      setCopied('Copy blocked: select the text below instead.') // insecure origin / old TV
    }
  }

  // The tokens' page layout (#230): Settings' column of cards (.settings).
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
            <span>Gateway: {gw ? (gw.name ?? gw.id) : 'none'}</span>
          )}
          <button
            type="button"
            className="primary"
            autoFocus
            disabled={!gatewayId || running}
            onClick={run}
          >
            {running ? 'Testing…' : 'Test connection'}
          </button>
          <label>
            <input
              type="checkbox"
              checked={relayOn()}
              onChange={(e) => setFlag('relay', e.target.checked)}
            />{' '}
            Force relay (TURN)
          </label>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Report</h2>
          <button type="button" onClick={copy}>
            Copy report
          </button>
        </div>
        {copied && <p role="status">{copied}</p>}
        <pre className="report">{report}</pre>
      </div>
    </section>
  )
}
