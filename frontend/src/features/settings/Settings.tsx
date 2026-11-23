import { Link } from '@tanstack/react-router'
import { PageBar } from '../../shared/PageBar'
import { signOut } from '@firebase/auth'
import { auth } from '../../shared/firebase'
import { TvToggle } from '../tv/TvMode'
import { arrowFocus } from '../../shared/focus'
import { AliasSetting } from '../../shared/Alias'
import { DiagnosticsToggle } from '../diagnostics/Diagnostics'
import { Playback } from './Playback'

// Per-device settings, in sections.
export function Settings() {
  return (
    <section className="settings" onKeyDown={arrowFocus}>
      <PageBar title="Settings" />
      <div className="head">
        <p className="muted">These apply to this device only.</p>
      </div>

      <Playback />

      <div className="card">
        <h2>Display</h2>
        <ul className="rows">
          <li>
            <TvToggle />
            <p className="muted">
              Larger text and a margin for TVs that crop the picture edges.
            </p>
          </li>
        </ul>
      </div>

      <div className="card">
        <h2>Account</h2>
        <ul className="rows">
          {auth.currentUser && (
            <li className="no-tv">
              <AliasSetting user={auth.currentUser} />
              <p className="muted">
                What members of your households see instead of your email.
              </p>
            </li>
          )}
          <li>
            <span className="setting">
              Signed in as{' '}
              <span className="muted">{auth.currentUser?.email}</span>
            </span>
            <button type="button" onClick={() => signOut(auth)}>
              Sign out
            </button>
          </li>
        </ul>
      </div>

      <div className="card">
        <h2>Diagnostics</h2>
        <ul className="rows">
          <li>
            <DiagnosticsToggle />
            <p className="muted">
              Connection, CPU and memory details on every page, to report a
              problem.
            </p>
          </li>
          <li>
            <Link to="/diagnostics">Client info + connection test</Link>
            <p className="muted">
              What this browser can play, and a speed test to your gateway.
            </p>
          </li>
        </ul>
      </div>
    </section>
  )
}
