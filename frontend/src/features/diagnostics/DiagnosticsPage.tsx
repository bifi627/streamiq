// /diagnostics (#90): what this client can play, and how good its path to a
// gateway is, as a report to paste into a support request. No email, no IPs.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { diag, relayOn, setFlag, snapshot, subscribe } from '../../diag'
import { pairInfo } from '../../stats'
import { connect, NotPaired } from '../pairing/connect'
import { getGateways, type Gateway } from '../gateways/api'
import { describe, probe } from '../library/profile'

type Test = { lines: string[]; failed?: string }

export function DiagnosticsPage() {
  useSyncExternalStore(subscribe, snapshot) // Force relay checkbox
  const [caps, setCaps] = useState('probing…')
  const [gateways, setGateways] = useState<Gateway[]>([])
  const [gatewayId, setGatewayId] = useState('')
  const [test, setTest] = useState<Test | null>(null)
  const [running, setRunning] = useState(false)
  const [copied, setCopied] = useState('')

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
      const s = await connect(gatewayId, undefined, true).catch((e) => {
        if (e instanceof NotPaired) lines.push('paired: no')
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
      await s.speed!.get(60_000) // the session's own measurement (speed.ts)
      const mbps = s.speed!.fresh()
      if (!mbps) throw new Error(s.speed!.error() ?? 'timed out')
      lines.push(
        `throughput: ${mbps.toFixed(1)} Mbps (median of 3 × 1 MiB bursts; Auto caps at ${(mbps * 0.7).toFixed(1)} Mbps)`,
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

  return (
    <section>
      <h2>Diagnostics</h2>
      <p>
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
        </label>{' '}
        <button
          type="button"
          autoFocus
          disabled={!gatewayId || running}
          onClick={run}
        >
          {running ? 'Testing…' : 'Test connection'}
        </button>{' '}
        <label>
          <input
            type="checkbox"
            checked={relayOn()}
            onChange={(e) => setFlag('relay', e.target.checked)}
          />{' '}
          Force relay (TURN)
        </label>
      </p>
      <p>
        <button type="button" onClick={copy}>
          Copy report
        </button>{' '}
        {copied}
      </p>
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          border: '1px solid #888',
          padding: 8,
          textAlign: 'left',
          userSelect: 'all',
        }}
      >
        {report}
      </pre>
    </section>
  )
}
