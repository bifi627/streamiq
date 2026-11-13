import { createContext, useContext } from 'react'
import { setHousehold, type Me } from '../../api'

// The one /me of this page load (Shell fetches it) and the household it acts in.
// null until /me is in.
export const HouseholdContext = createContext<Me | null>(null)

export function useHousehold() {
  const me = useContext(HouseholdContext)
  return {
    me,
    current: me?.memberships.find((m) => m.id === me.tenantId),
  }
}

// Switching = per-device choice, then a full reload of the home page: closes every
// tunnel session and drops all in-memory data of the old household (shared tunnel
// sessions, lists, player). null = the API's default (the oldest membership).
// ponytail: full reload, swap in-place (reset context + caches) if it feels slow.
export function switchHousehold(id: string | null) {
  setHousehold(id)
  location.replace('/')
}

// Unnamed households (no rename yet) are told apart by the end of their id (the
// start is a UUIDv7 timestamp, alike for households made close together).
export const householdLabel = (m: { id: string; name: string | null }) =>
  m.name ?? `Household …${m.id.slice(-6)}`
