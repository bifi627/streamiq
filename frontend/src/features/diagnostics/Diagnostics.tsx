import { useSyncExternalStore } from 'react'
import { Link } from '@tanstack/react-router'
import { arrowFocus } from '../../shared/focus'
import {
  debugOn,
  diag,
  dockOpen,
  relayOn,
  setFlag,
  setRelay,
  snapshot,
  subscribe,
} from '../../shared/diag'

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

/** The live panel, a dock on the bottom edge: one line collapsed
 * (peer · channels in flight · last event), its button opens a sheet. The D-pad
 * reaches the button with Down (arrowFocus on the shell; the player's bar,
 * Controls.tsx). The spacer keeps the page scrollable past it. */
export function Diagnostics() {
  useSyncExternalStore(subscribe, snapshot)
  const open = dockOpen() // remembered per device, like the panel itself
  if (!debugOn()) return null
  const last = diag.events[diag.events.length - 1]
  return (
    <>
      <div className={open ? 'dock-space open' : 'dock-space'} />
      {/* its own D-pad box first: the sheet covers what's below the bar */}
      <aside className="dock" aria-label="Diagnostics" onKeyDown={arrowFocus}>
        <button
          type="button"
          className="dock-bar"
          aria-expanded={open}
          onClick={() => setFlag('dock', !open)}
        >
          <span className="dock-title">
            <span aria-hidden="true">{open ? '▾' : '▴'}</span> Diagnostics
          </span>
          <span>
            peer: <b>{diag.pc || 'no session'}</b> · channels in flight:{' '}
            <b>{diag.inFlight}</b> (peak {diag.peak})
          </span>
          {/* open: the log below shows it */}
          {!open && last && <span className="dock-last">{last}</span>}
        </button>
        {open && (
          <div className="dock-sheet">
            <div className="dock-info">
              <div>
                {navigator.userAgent} ·{' '}
                <Link to="/diagnostics">Client info + connection test</Link>
              </div>
              {diag.cpu && <div>cpu: {diag.cpu}</div>}
              {diag.memory && <div>memory: {diag.memory}</div>}
              {diag.media && <div>video: {diag.media}</div>}
              {diag.sb && <div>hls: {diag.sb}</div>}
              <label>
                <input
                  type="checkbox"
                  checked={relayOn()}
                  onChange={(e) => setRelay(e.target.checked)}
                />{' '}
                Force relay (TURN) on next connect
              </label>
            </div>
            <div className="dock-reqs">
              <table>
                <tbody>
                  {[...diag.reqs].reverse().map((r, i) => (
                    <tr key={i}>
                      <td>{r.opened ? 'opened' : 'not opened'}</td>
                      <td>{r.ms === undefined ? '…' : `${r.ms}ms`}</td>
                      <td>{r.result ?? 'pending'}</td>
                      <td>{r.path}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <pre className="dock-log">
              {[...diag.events].reverse().join('\n')}
            </pre>
          </div>
        )}
      </aside>
    </>
  )
}
