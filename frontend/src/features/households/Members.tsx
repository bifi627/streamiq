import { useEffect, useState } from 'react'
import { authed, getMe, setHousehold } from '../../api'
import { AppError, toAppError } from '../../errors'
import { ErrorView } from '../../ErrorView'

type Member = {
  userId: string
  name: string | null
  email: string | null
  role: 'admin' | 'member'
  joinedAt: string
}

// The API refuses (409) anything that would leave the household without an admin.
const asMember = (e: unknown) => {
  const x = toAppError(e)
  return x.context.status === 409 ? new AppError('last-admin', x.message) : x
}

// Members of the current household (#192): anyone sees them and can leave; an
// admin removes, promotes and demotes. A change to your own membership reloads
// the app, so every view picks up the new role (or another household after leaving).
export function Members() {
  const [members, setMembers] = useState<Member[]>([])
  const [me, setMe] = useState<{ id: string; admin: boolean } | null>(null)
  const [err, setErr] = useState<AppError | null>(null)

  const load = () =>
    authed<Member[]>('/members')
      .then(setMembers)
      .catch((e) => setErr(toAppError(e)))
  useEffect(() => {
    load()
    getMe()
      .then((m) =>
        setMe({
          id: m.userId,
          admin:
            m.memberships.find((x) => x.id === m.tenantId)?.role === 'admin',
        }),
      )
      .catch((e) => setErr(toAppError(e)))
  }, [])

  async function act(m: Member, init: RequestInit, path = '') {
    setErr(null)
    try {
      await authed(`/members/${m.userId}${path}`, init)
      if (m.userId !== me?.id) return void (await load())
      // Left: the API falls back to the oldest household (or makes a new one).
      if (init.method === 'DELETE') setHousehold(null)
      location.replace('/')
    } catch (e) {
      setErr(asMember(e))
    }
  }
  const who = (m: Member) => m.name ?? m.email ?? 'unknown user'
  const remove = (m: Member) =>
    confirm(
      m.userId === me?.id
        ? 'Leave this household? You lose access to its gateways.'
        : `Remove ${who(m)} from this household?`,
    ) && act(m, { method: 'DELETE' })
  const setRole = (m: Member, role: Member['role']) =>
    (m.userId !== me?.id ||
      confirm(
        'Make yourself a member? Only another admin can make you admin again.',
      )) &&
    act(m, { method: 'PUT', body: JSON.stringify({ role }) }, '/role')

  return (
    <section>
      <h2>Members</h2>
      {err && <ErrorView error={err} />}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {members.map((m) => (
          <li key={m.userId}>
            {who(m)}
            {m.name && m.email && (
              <span style={{ color: '#888' }}> {m.email}</span>
            )}
            {m.userId === me?.id && ' (you)'} — {m.role}, joined{' '}
            {new Date(m.joinedAt).toLocaleDateString()}{' '}
            {me?.admin &&
              (m.role === 'admin' ? (
                <button type="button" onClick={() => setRole(m, 'member')}>
                  Make member
                </button>
              ) : (
                <button type="button" onClick={() => setRole(m, 'admin')}>
                  Make admin
                </button>
              ))}{' '}
            {(me?.admin || m.userId === me?.id) && (
              <button type="button" onClick={() => remove(m)}>
                {m.userId === me?.id ? 'Leave' : 'Remove'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
