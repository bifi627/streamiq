import { useContext, useRef, useState } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { signOut } from '@firebase/auth'
import { auth } from '../../shared/firebase'
import { renameHousehold } from '../../shared/api'
import { describe, toAppError } from '../../shared/errors'
import { ErrorView } from '../../shared/ErrorView'
import { arrowFocus } from '../../shared/focus'
import { STORED } from '../../shared/EditableName'
import { EditableTitle } from '../../shared/EditableTitle'
import { Menu } from '../../shared/Menu'
import { Dialog } from '../../shared/Dialog'
import { Tile } from '../../shared/Tile'
import { useBack } from '../../shared/slots'
import {
  householdLabel,
  SetMeContext,
  useCreate,
  useHousehold,
} from './household'
import { Invites } from './Invites'
import { Members } from './Members'
import { PageBar } from '../../shared/PageBar'
import { Activity } from '../activity/Activity'

// /settings/household: the active household (each page load acts in one):
// Members, (admin) Invites and Activity tiles; Rename and Delete in the title
// row's ⋮.
export function Household() {
  const { me, current } = useHousehold()
  const setMe = useContext(SetMeContext)
  // An admin names the household: shown at once, here and on the overview.
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
      <div className="tiles">
        <Tile title="Members" open>
          <Members />
        </Tile>
        {current?.role === 'admin' && (
          <Tile title="Invites">
            <Invites />
          </Tile>
        )}
        <ActivityTile />
      </div>
    </section>
  )
}

// Opened by /activity's redirect (#activity); loads only once opened, as it
// opens a tunnel per gateway, and stays mounted (filters kept) after closing.
function ActivityTile() {
  const deep = useLocation().hash === 'activity'
  const [seen, setSeen] = useState(deep)
  return (
    <Tile title="Activity" open={deep} wide onOpen={(o) => o && setSeen(true)}>
      {seen && <Activity />}
    </Tile>
  )
}

// The title row: Back to the overview, the name, and for an admin ⋮ → Rename
// (turns the title into the rename form) and Delete.
function Title({
  rename,
}: {
  rename: (name: string) => Promise<string | null>
}) {
  const { current } = useHousehold()
  const navigate = useNavigate()
  const back = useBack(() =>
    navigate({ to: '/settings/households', replace: true }),
  )
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const menu = useRef<HTMLButtonElement>(null)
  const admin = current?.role === 'admin'
  return (
    <>
      <PageBar
        onBack={back}
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
              actions={[
                { label: 'Rename', run: () => setRenaming(true) },
                { label: 'Delete', run: () => setDeleting(true) },
              ]}
              button={menu}
            />
          )
        }
      />
      {/* TODO(#877): a dialog until a delete-household API exists */}
      {deleting && (
        <Dialog title="Delete household" onClose={() => setDeleting(false)}>
          <p>Deleting a household isn't available yet.</p>
        </Dialog>
      )}
    </>
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
