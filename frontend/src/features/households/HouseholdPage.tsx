import { useContext, useState } from 'react'
import { signOut } from '@firebase/auth'
import { auth } from '../../firebase'
import { createHousehold, renameHousehold } from '../../api'
import { AppError, describe, toAppError } from '../../errors'
import { ErrorView } from '../../ErrorView'
import { arrowFocus } from '../../focus'
import { EditableName } from '../gateways/Gateways'
import {
  householdLabel,
  SetMeContext,
  switchHousehold,
  useHousehold,
} from './household'
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

// Signed in, in no household (#387): sign-up makes none. Shell shows this in place
// of every page but Settings and /join. Create one (as its admin), or open an
// invite link someone sent. Both reload into the household they lead to.
export function NoHousehold() {
  const [link, setLink] = useState('')
  const [err, setErr] = useState<AppError | null>(null)
  const [busy, setBusy] = useState(false)
  // A whole link (…/join#<token>) or the bare token.
  const token = link.trim().split('#').pop() ?? ''

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

  return (
    <section className="card join" onKeyDown={arrowFocus}>
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M3 11l9-7 9 7M5 10v10h14V10" />
      </svg>
      <h1>You're not in a household yet</h1>
      <p className="muted">
        A household shares its gateways with its members. Create your own to add
        your home PC or NAS, or join one with an invite link.
      </p>
      {err && <ErrorView error={err} />}
      <div className="actions">
        <button
          type="button"
          className="primary"
          autoFocus
          disabled={busy}
          onClick={create}
        >
          Create a household
        </button>
      </div>
      <form
        className="actions"
        onSubmit={(e) => {
          e.preventDefault()
          if (token) location.assign(`/join#${token}`)
        }}
      >
        <input
          aria-label="Invite link"
          placeholder="Paste an invite link"
          value={link}
          onChange={(e) => setLink(e.target.value)}
        />
        <button type="submit" disabled={!token}>
          Open
        </button>
      </form>
      <button type="button" className="link" onClick={() => signOut(auth)}>
        Sign out
      </button>
    </section>
  )
}
