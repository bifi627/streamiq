import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { PageBar } from '../../shared/PageBar'
import { signOut } from '@firebase/auth'
import { auth } from '../../shared/firebase'
import { TvToggle } from '../tv/TvMode'
import { arrowFocus } from '../../shared/focus'
import { AliasSetting } from '../../shared/Alias'
import { DiagnosticsToggle } from '../diagnostics/Diagnostics'

// Settings overview: a row per category. More than 2 settings → its own page
// (ends in ›), else it expands in place (⌄).
export function Settings() {
  return (
    <section className="settings" onKeyDown={arrowFocus}>
      <PageBar title="Settings" />
      <ul className="card categories">
        <li>
          <Link to="/settings/playback" autoFocus>
            Playback
            <Chevron />
          </Link>
        </li>
        <Category name="Display">
          <li>
            <TvToggle />
            <p className="muted">
              Larger text and a margin for TVs that crop the picture edges.
              This device only.
            </p>
          </li>
        </Category>
        <Category
          name="Account"
          detail={<span className="muted">{auth.currentUser?.email}</span>}
        >
          {auth.currentUser && (
            <li className="no-tv">
              <AliasSetting user={auth.currentUser} />
              <p className="muted">
                What members of your households see instead of your email.
              </p>
            </li>
          )}
          <li>
            <button type="button" onClick={() => signOut(auth)}>
              Sign out
            </button>
          </li>
        </Category>
        <Category name="Diagnostics">
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
        </Category>
      </ul>
    </section>
  )
}

// A category that expands in place; closed on load.
function Category({
  name,
  detail,
  children,
}: {
  name: string
  detail?: ReactNode
  children: ReactNode
}) {
  return (
    <li>
      <details>
        <summary>
          {name}
          {detail}
          <Chevron />
        </summary>
        <ul className="rows">{children}</ul>
      </details>
    </li>
  )
}

// › on a page row; turned to ⌄ (and up when open) on an expandable (index.css).
function Chevron() {
  return (
    <svg className="chevron" aria-hidden="true" viewBox="0 0 24 24">
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}
