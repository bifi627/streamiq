import { useContext } from 'react'
import { renameHousehold } from '../../api'
import { describe, toAppError } from '../../errors'
import { arrowFocus } from '../../focus'
import { EditableName } from '../gateways/Gateways'
import { householdLabel, SetMeContext, useHousehold } from './household'
import { Invites } from './Invites'
import { Members } from './Members'

// /household (#228): who's in the current household, and (admin) invites.
// Its own page, not under the Gateways list: those are what you open daily,
// this is what you manage now and then.
export function Household() {
  const { me, current } = useHousehold()
  const setMe = useContext(SetMeContext)
  // An admin names the household (#384): shown at once, here and in the switcher.
  // null = renamed; else the error to show in the form.
  async function rename(name: string) {
    try {
      const stored = await renameHousehold(name)
      if (me)
        setMe({
          ...me,
          memberships: me.memberships.map((m) =>
            m.id === me.tenantId ? { ...m, name: stored } : m,
          ),
        })
      return null
    } catch (e) {
      const x = toAppError(e)
      return x.context.status === 400
        ? 'Use 1–100 characters, no control characters.'
        : describe(x).message
    }
  }
  return (
    <section className="household" onKeyDown={arrowFocus}>
      <div className="head">
        {current ? (
          <EditableName
            name={current.name ?? ''}
            label="Household name"
            rename={current.role === 'admin' ? rename : undefined}
          >
            <h1>{householdLabel(current)}</h1>
          </EditableName>
        ) : (
          <h1>Household</h1>
        )}
        {current && (
          <span className="chip">
            {current.role === 'admin' ? 'You are an admin' : 'You are a member'}
          </span>
        )}
      </div>
      <Members />
      {current?.role === 'admin' && <Invites />}
    </section>
  )
}
