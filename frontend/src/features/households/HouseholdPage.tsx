import { useContext, useRef, useState } from 'react'
import { signOut } from '@firebase/auth'
import { auth } from '../../shared/firebase'
import { createHousehold, renameHousehold } from '../../shared/api'
import { AppError, describe, toAppError } from '../../shared/errors'
import { ErrorView } from '../../shared/ErrorView'
import { arrowFocus } from '../../shared/focus'
import { STORED } from '../../shared/EditableName'
import { EditableTitle } from '../../shared/EditableTitle'
import { Menu } from '../../shared/Menu'
import {
  householdLabel,
  membershipLabel,
  SetMeContext,
  switchHousehold,
  useHousehold,
} from './household'
import { Invites } from './Invites'
import { Members } from './Members'
import { PageBar } from '../../shared/PageBar'
import type { Me } from '../../shared/api'

// /household: who's in the current household, and (admin) invites.
// Its own page, not under the Gateways list: those are what you open daily,
// this is what you manage now and then.
export function Household() {
  const { me, current } = useHousehold()
  const setMe = useContext(SetMeContext)
  // An admin names the household: shown at once, here and in the switcher.
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
      <Title rename={rename} />
      {current && (
        <div className="head">
          <span className="chip">
            {current.role === 'admin' ? 'You are an admin' : 'You are a member'}
          </span>
          {me && me.memberships.length > 1 && <Switcher me={me} />}
        </div>
      )}
      <Members />
      {current?.role === 'admin' && <Invites />}
      {current && <CreateAnother />}
    </section>
  )
}

// The title row: the name, and for an admin ⋮ → Rename, which turns the
// title into the rename form.
function Title({
  rename,
}: {
  rename: (name: string) => Promise<string | null>
}) {
  const { current } = useHousehold()
  const [renaming, setRenaming] = useState(false)
  const menu = useRef<HTMLButtonElement>(null)
  const admin = current?.role === 'admin'
  return (
    <PageBar
      title={
        current ? (
          <EditableTitle
            title={householdLabel(current)}
            editing={renaming && admin}
            name={current.name ?? ''}
            label="Household name"
            hint={STORED}
            rename={rename}
            onClose={() => {
              setRenaming(false)
              menu.current?.focus() // the form had it: keep the D-pad's place
            }}
          />
        ) : (
          'Household'
        )
      }
      actions={
        admin && (
          <Menu
            label="Household actions"
            actions={[{ label: 'Rename', run: () => setRenaming(true) }]}
            button={menu}
          />
        )
      }
    />
  )
}

// Switching reloads into the picked household (household.ts).
function Switcher({ me }: { me: Me }) {
  return (
    <select
      aria-label="Switch household"
      value={me.tenantId ?? ''}
      onChange={(e) => switchHousehold(e.target.value)}
    >
      {me.memberships.map((m) => (
        <option key={m.id} value={m.id}>
          {membershipLabel(m)}
        </option>
      ))}
    </select>
  )
}

// Makes a household with the user as its admin and reloads into it.
function useCreate() {
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

// A member of someone else's household makes one of their own, e.g. for their
// own gateway. Asked first: one stray OK on a TV would make a household.
function CreateAnother() {
  const { err, busy, create } = useCreate()
  return (
    <div>
      {err && <ErrorView error={err} />}
      <div className="actions">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            confirm(
              'Create a new household? You become its admin and switch to it.',
            ) && create()
          }
        >
          Create another household
        </button>
      </div>
    </div>
  )
}

// Signed in, in no household: sign-up makes none. Shell shows this in place
// of every page but Settings and /join. Create one (as its admin), or open an
// invite link someone sent. Both reload into the household they lead to.
export function NoHousehold() {
  const [link, setLink] = useState('')
  const { err, busy, create } = useCreate()
  // A whole link (…/join#<token>) or the bare token.
  const token = link.trim().split('#').pop() ?? ''

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
          if (token) location.assign(`/join#${encodeURIComponent(token)}`) // base64url: unchanged
        }}
      >
        <input
          autoFocus // not on Create: one stray OK on a TV would make a household
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
