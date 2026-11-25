import { Link, useNavigate } from '@tanstack/react-router'
import { PageBar } from '../../shared/PageBar'
import { Chevron } from '../../shared/Chevron'
import { ErrorView } from '../../shared/ErrorView'
import { arrowFocus } from '../../shared/focus'
import { useBack } from '../../shared/slots'
import { activeFirst } from '../gateways/list'
import { membersLabel, roleView } from './memberNames'
import {
  householdLabel,
  switchHere,
  useCreate,
  useHousehold,
} from './household'
import type { Household } from '../../generated/auth'

// /settings/households: a card per household the user is in, the active one
// first (its details behind the chevron), Switch on the others; + makes one.
export function Households() {
  const navigate = useNavigate()
  const back = useBack(() => navigate({ to: '/settings', replace: true }))
  const { me } = useHousehold()
  const { err, busy, create } = useCreate()
  return (
    <section className="households" onKeyDown={arrowFocus}>
      <PageBar
        title="Households"
        onBack={back}
        actions={
          <button
            type="button"
            className="icon-btn"
            aria-label="Create household"
            title="Create household"
            disabled={busy}
            onClick={() =>
              // Asked first: one stray OK on a TV would make a household.
              confirm(
                'Create a new household? You become its admin and switch to it.',
              ) && create()
            }
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        }
      />
      {err && <ErrorView error={err} />}
      {me && (
        <ul className="cards">
          {activeFirst(me.memberships, me.tenantId).map((m) => (
            <Card key={m.id} m={m} active={m.id === me.tenantId} />
          ))}
        </ul>
      )}
    </section>
  )
}

// The role is in words beside its dot: color is never the only signal.
function Card({ m, active }: { m: Household; active: boolean }) {
  const role = roleView(m.role)
  return (
    <li className={active ? 'card gw hh active' : 'card gw hh'}>
      <div className="gw-head">
        <span className={`dot role-${m.role}`} aria-hidden="true" />
        {active ? (
          <Link className="gw-link" to="/settings/household">
            {householdLabel(m)}
          </Link>
        ) : (
          <span>{householdLabel(m)}</span>
        )}
      </div>
      <span className="meta muted">
        {role.label} · {membersLabel(m.members)}
      </span>
      <div className="actions">
        {active ? (
          <>
            <span className="chip active-chip">Active</span>
            <Chevron />
          </>
        ) : (
          <button type="button" onClick={() => switchHere(m.id)}>
            Switch
          </button>
        )}
      </div>
    </li>
  )
}
