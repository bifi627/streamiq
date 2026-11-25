import { createContext, useContext, useState } from 'react'
import { createHousehold, setHousehold, type Me } from '../../shared/api'
import { toAppError, type AppError } from '../../shared/errors'
import { clearArtThen } from '../../shared/leave'
import { noop } from '../../shared/noop'
import { switchTarget } from './switchTarget'
import { householdLabel } from '../../shared/api'
export { householdLabel }

/** A household in a switcher: its name and the user's role there. */
export const membershipLabel = (m: Me['memberships'][number]) =>
  `${householdLabel(m)} (${m.role})`

// The one /me of this page load (Shell fetches it) and the household it acts in.
// null until /me is in.
export const HouseholdContext = createContext<Me | null>(null)
// Shell's setter, for a change made on this page (a household rename).
export const SetMeContext = createContext<(me: Me) => void>(noop)

export function useHousehold() {
  const me = useContext(HouseholdContext)
  return {
    me,
    current: me?.memberships.find((m) => m.id === me.tenantId),
  }
}

// Switching = per-device choice, then a full reload: closes every tunnel session
// and drops all in-memory data of the old household (shared tunnel sessions,
// lists, player). null = the API's default (the oldest membership).
// ponytail: full reload, swap in-place (reset context + caches) if it feels slow.
export function switchHousehold(id: string | null, to = '/') {
  setHousehold(id)
  clearArtThen(() => location.replace(to))
}

/** Switch picked by the user: stays on this page when it allows it. */
export const switchHere = (id: string | null) =>
  switchHousehold(id, switchTarget(location.pathname))

// Makes a household with the user as its admin and reloads into it.
export function useCreate() {
  const [err, setErr] = useState<AppError | null>(null)
  const [busy, setBusy] = useState(false)
  async function create() {
    setBusy(true)
    setErr(null)
    try {
      switchHousehold((await createHousehold()).householdId)
    } catch (e) {
      setErr(toAppError(e))
      setBusy(false)
    }
  }
  return { err, busy, create }
}
