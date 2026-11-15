import { ADMIN_ONLY } from '../../errors'
import { arrowFocus } from '../../focus'
import { householdLabel, useHousehold } from './household'
import { Invites } from './Invites'
import { Members } from './Members'

// /household (#228): who's in the current household, and (admin) invites.
// Its own page, not under the Gateways list: those are what you open daily,
// this is what you manage now and then.
export function Household() {
  const { current } = useHousehold()
  return (
    <section className="household" onKeyDown={arrowFocus}>
      <div className="head">
        <h1>{current ? householdLabel(current) : 'Household'}</h1>
        {current && (
          <span className="chip">
            {current.role === 'admin' ? 'You are an admin' : 'You are a member'}
          </span>
        )}
      </div>
      <Members />
      {current?.role === 'admin' && <Invites />}
      {current?.role === 'member' && (
        <section className="card">
          <h2>Invites</h2>
          <p className="meta muted">Invite someone: {ADMIN_ONLY}</p>
        </section>
      )}
    </section>
  )
}
