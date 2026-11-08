import { useSyncExternalStore } from 'react'
import {
  debugOn,
  diag,
  relayOn,
  setFlag,
  snapshot,
  subscribe,
  transcodeOn,
  fmp4On,
} from './diag'

/** Header button: a TV remote can reach it, unlike the URL bar. */
export function DiagnosticsToggle() {
  useSyncExternalStore(subscribe, snapshot)
  const on = debugOn()
  return (
    <button type="button" onClick={() => setFlag('debug', !on)}>
      {on ? 'Hide diagnostics' : 'Diagnostics'}
    </button>
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
      <div>{navigator.userAgent}</div>
      <div>
        peer: <b>{diag.pc || 'no session'}</b> · channels in flight:{' '}
        <b>{diag.inFlight}</b> (peak {diag.peak})
      </div>
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
      <label>
        <input
          type="checkbox"
          checked={transcodeOn()}
          onChange={(e) => setFlag('transcode', e.target.checked)}
        />{' '}
        Force transcode (video + stereo audio, no stream copy) on next play
      </label>
      <label>
        <input
          type="checkbox"
          checked={fmp4On()}
          onChange={(e) => setFlag('fmp4', e.target.checked)}
        />{' '}
        fMP4 segments instead of .ts on next play
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
