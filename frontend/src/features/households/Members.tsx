import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { authed } from '../../api'
import { switchHousehold, useHousehold } from './household'
import { ADMIN_ONLY, AppError, toAppError } from '../../errors'
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
  const q = useQuery({
    queryKey: ['members'],
    queryFn: () => authed<Member[]>('/members'),
  })
  const members = q.data ?? []
  const { me: m0, current } = useHousehold()
  const me = m0 && { id: m0.userId, admin: current?.role === 'admin' }
  const [actErr, setErr] = useState<AppError | null>(null)
  const err = actErr ?? (q.error && toAppError(q.error))
  const qc = useQueryClient()
  // Remove goes with its row: then focus the row now at its place (or the
  // last), or the D-pad (arrowFocus on the page) loses its place (#226).
  const list = useRef<HTMLUListElement>(null)
  const refocus = useRef<number | null>(null)

  useEffect(() => {
    const i = refocus.current
    if (i === null) return
    refocus.current = null
    const rows = list.current?.children ?? []
    rows[Math.min(i, rows.length - 1)]?.querySelector('button')?.focus()
  }, [q.data])

  const acting = useMutation({
    mutationFn: (a: { m: Member; init: RequestInit; path?: string }) =>
      authed(`/members/${a.m.userId}${a.path ?? ''}`, a.init),
    onMutate: () => setErr(null),
    onSuccess: (_, { m, init }) => {
      if (m.userId !== me?.id) {
        if (init.method === 'DELETE') refocus.current = members.indexOf(m)
        return qc.invalidateQueries({ queryKey: ['members'] })
      }
      // Left: the API falls back to the oldest household (or makes a new one).
      // Role changed: reload, so every view picks up the new role.
      if (init.method === 'DELETE') switchHousehold(null)
      else location.replace('/')
    },
    onError: (e) => setErr(asMember(e)),
  })
  const act = (m: Member, init: RequestInit, path?: string) =>
    acting.mutate({ m, init, path })
  const who = (m: Member) => m.name || m.email || 'unknown user'
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
    <section className="card">
      <h2>Members</h2>
      {err && <ErrorView error={err} />}
      <ul className="rows" ref={list}>
        {members.map((m) => {
          const self = m.userId === me?.id
          return (
            <li key={m.userId}>
              <span className="avatar" aria-hidden="true">
                {[
                  ...new Intl.Segmenter().segment(who(m)),
                ][0].segment.toUpperCase()}
              </span>
              <span className="who">
                <span className="name-line">
                  <b>
                    {who(m)}
                    {self && <span className="muted"> (you)</span>}
                  </b>
                  <span className={m.role === 'admin' ? 'chip admin' : 'chip'}>
                    {m.role === 'admin' ? 'Admin' : 'Member'}
                  </span>
                </span>
                {m.name && m.email && (
                  <span className="meta muted">{m.email}</span>
                )}
                <span className="meta muted">
                  Joined {new Date(m.joinedAt).toLocaleDateString()}
                </span>
              </span>
              {(me?.admin || self) && (
                <span className="row-actions">
                  {me?.admin && (
                    <button
                      type="button"
                      onClick={() =>
                        setRole(m, m.role === 'admin' ? 'member' : 'admin')
                      }
                    >
                      {m.role === 'admin' ? 'Make member' : 'Make admin'}
                    </button>
                  )}
                  <button type="button" onClick={() => remove(m)}>
                    {self ? 'Leave' : 'Remove'}
                  </button>
                </span>
              )}
            </li>
          )
        })}
      </ul>
      {me && !me.admin && (
        <p className="meta muted">
          Invite someone, remove members, change roles: {ADMIN_ONLY}
        </p>
      )}
    </section>
  )
}
