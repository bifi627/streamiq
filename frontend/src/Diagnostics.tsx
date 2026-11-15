import { useSyncExternalStore } from 'react'
import { Link } from '@tanstack/react-router'
import { debugOn, diag, relayOn, setFlag, snapshot, subscribe } from './diag'

/** Settings checkbox: a TV remote can reach it, unlike the URL bar. */
export function DiagnosticsToggle() {
  useSyncExternalStore(subscribe, snapshot)
  return (
    <label className="setting">
      <input
        type="checkbox"
        checked={debugOn()}
        onChange={(e) => setFlag('debug', e.target.checked)}
      />{' '}
      Diagnostics panel
    </label>
  )
}

export function Diagnostics() {
  useSyncExternalStore(subscribe, snapshot)
  if (!debugOn()) return null
  return (
    <section
      style={{
        fontFamily: 'monospace',
        fontSize: 14,
        textAlign: 'left',
        border: '1px solid #888',
        padding: 8,
        margin: '1rem 0',
        overflowX: 'auto',
      }}
    >
      <div>
        {navigator.userAgent} ·{' '}
        <Link to="/diagnostics">Client info + connection test</Link>
      </div>
      <div>
        peer: <b>{diag.pc || 'no session'}</b> · channels in flight:{' '}
        <b>{diag.inFlight}</b> (peak {diag.peak})
      </div>
      {diag.cpu && <div>cpu: {diag.cpu}</div>}
      {diag.memory && <div>memory: {diag.memory}</div>}
      {diag.media && <div>video: {diag.media}</div>}
      {diag.sb && <div>hls: {diag.sb}</div>}
      <label>
        <input
          type="checkbox"
          checked={relayOn()}
          onChange={(e) => setFlag('relay', e.target.checked)}
        />{' '}
        Force relay (TURN) on next connect
      </label>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          {[...diag.reqs].reverse().map((r, i) => (
            <tr key={i}>
              <td>{r.opened ? 'opened' : 'not opened'}</td>
              <td>{r.ms === undefined ? '…' : `${r.ms}ms`}</td>
              <td>{r.result ?? 'pending'}</td>
              <td style={{ wordBreak: 'break-all' }}>{r.path}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
        {[...diag.events].reverse().join('\n')}
      </pre>
    </section>
  )
}
