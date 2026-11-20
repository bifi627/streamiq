import {
  Link,
  useCanGoBack,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { signOut } from '@firebase/auth'
import { auth } from '../../firebase'
import { TvToggle } from '../../Tv'
import { arrowFocus } from '../../focus'
import { AliasSetting } from '../../Alias'
import { DiagnosticsToggle } from '../../Diagnostics'
import { Playback } from './Playback'

// Per-device settings, in sections. Back goes back in history;
// after a deep link (no in-app history) it goes home instead of leaving the app.
export function Settings() {
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const navigate = useNavigate()
  return (
    <section className="settings" onKeyDown={arrowFocus}>
      <button
        type="button"
        className="back"
        onClick={() =>
          canGoBack
            ? router.history.back()
            : navigate({ to: '/', replace: true })
        }
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M15 6l-6 6 6 6" />
        </svg>
        Back
      </button>
      <div className="head">
        <h1>Settings</h1>
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
            <li>
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
