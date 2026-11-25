import { useSyncExternalStore, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { PageBar } from '../../shared/PageBar'
import { Chevron } from '../../shared/Chevron'
import { signOut } from '@firebase/auth'
import { auth } from '../../shared/firebase'
import { TvToggle } from '../tv/TvMode'
import { arrowFocus } from '../../shared/focus'
import { AliasSetting } from '../../shared/Alias'
import { DiagnosticsToggle } from '../diagnostics/Diagnostics'
import {
  lastGateway,
  onLastGateway,
  onTv,
  setLastGateway,
  tvOn,
} from '../../shared/settings'
import {
  membershipLabel,
  switchHere,
  useHousehold,
} from '../households/household'
import { useGateways } from '../gateways/api'
import { gatewayName } from '../gateways/list'
import { libraryTarget } from '../../shell'
import { Picker } from './Picker'
import { tvPickers } from './switches'

// React's autoFocus skips links; a stable ref runs once, on mount.
const focus = (a: HTMLAnchorElement | null) => a?.focus()

// Settings overview: a row per category. More than 2 settings → its own page
// (ends in ›), else it expands in place (⌄).
export function Settings() {
  return (
    <section className="settings" onKeyDown={arrowFocus}>
      <PageBar title="Settings" />
      <Switches />
      <ul className="card categories">
        <li className="no-tv">
          <Link to="/settings/households">
            Households
            <Chevron />
          </Link>
        </li>
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
        <li>
          <Link to="/settings/playback" ref={focus}>
            Playback
            <Chevron />
          </Link>
        </li>
        <Category name="Display">
          <li>
            <TvToggle />
            <p className="muted">
              Larger text and a margin for TVs that crop the picture edges. This
              device only.
            </p>
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

// TV mode has no Household or Gateways page: which household it acts in and
// which gateway its Library tab opens are picked here, in a card of its own
// above the rest, open on load.
function Switches() {
  const tv = useSyncExternalStore(onTv, tvOn)
  const { me } = useHousehold()
  const gateways = useGateways().data ?? []
  const last = useSyncExternalStore(onLastGateway, lastGateway)
  const show = tvPickers(tv, me?.memberships.length ?? 0, gateways.length)
  if (!show.household && !show.gateway) return null
  return (
    <ul className="card categories">
      <Category name="Household & gateway" open>
        {show.household && me && (
          <li>
            <Picker
              label="Household"
              current={me.tenantId}
              choices={me.memberships.map((m) => ({
                id: m.id,
                text: membershipLabel(m),
              }))}
              pick={switchHere}
            />
          </li>
        )}
        {show.gateway && (
          <li>
            <Picker
              label="Gateway"
              current={libraryTarget(undefined, last, gateways)}
              choices={gateways.map((g) => ({
                id: g.id,
                text: `${gatewayName(g)} (${g.online ? 'online' : 'offline'})`,
              }))}
              pick={setLastGateway}
            />
          </li>
        )}
      </Category>
    </ul>
  )
}

// A category that expands in place; closed on load unless open.
function Category({
  name,
  detail,
  open,
  children,
}: {
  name: string
  detail?: ReactNode
  open?: boolean
  children: ReactNode
}) {
  return (
    <li>
      <details open={open}>
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
