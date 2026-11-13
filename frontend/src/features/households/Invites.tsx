import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { authed, setHousehold } from '../../api'
import { AppError, toAppError } from '../../errors'
import { ErrorView } from '../../ErrorView'

type Invite = { id: string; createdAt: string; expiresAt: string }
type Preview = { householdId: string; name: string | null; member: boolean }

// The token lives in the link's fragment (/join#<token>): never sent to a server
// as a URL, so it can't land in access logs. The API gets it in a POST body.
const linkFor = (token: string) => `${location.origin}/join#${token}`

// Invites of the current household (admin-only, #191): create a single-use link
// (7 days), list the pending ones, revoke one. The link is shown once.
export function Invites() {
  const [invites, setInvites] = useState<Invite[]>([])
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(
    null,
  )
  const [err, setErr] = useState<AppError | null>(null)

  const load = () =>
    authed<Invite[]>('/invites')
      .then(setInvites)
      .catch((e) => setErr(toAppError(e)))
  useEffect(() => {
    load()
  }, [])

  async function create() {
    setErr(null)
    try {
      const r = await authed<{ token: string; expiresAt: string }>('/invites', {
        method: 'POST',
      })
      setLink({ url: linkFor(r.token), expiresAt: r.expiresAt })
      await load()
    } catch (e) {
      setErr(toAppError(e))
    }
  }

  async function revoke(id: string) {
    setErr(null)
    try {
      await authed(`/invites/${id}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      setErr(toAppError(e))
    }
  }

  return (
    <section>
      <h2>Invites</h2>
      {err && <ErrorView error={err} />}
      <button type="button" onClick={create}>
        Invite someone
      </button>
      {link && (
        <div>
          <p>
            Send this link to the person you invite. It works once and expires{' '}
            {new Date(link.expiresAt).toLocaleString()}:
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {link.url}
          </pre>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(link.url)}
          >
            Copy
          </button>
        </div>
      )}
      {invites.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {invites.map((i) => (
            <li key={i.id}>
              Pending invite, created {new Date(i.createdAt).toLocaleString()},
              expires {new Date(i.expiresAt).toLocaleString()}{' '}
              <button type="button" onClick={() => revoke(i.id)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// Opening the joined household: per-device choice, then a full reload (fresh
// state everywhere).
function openHousehold(household: string) {
  setHousehold(household)
  location.replace('/')
}

// The API answers 404 for an unknown, expired, used or revoked invite alike.
const asInvite = (e: unknown) => {
  const x = toAppError(e)
  return x.context.status === 404
    ? new AppError('invite-invalid', x.message)
    : x
}

// /join#<token>: show which household the invite is for, join on confirm.
export function Join() {
  const navigate = useNavigate()
  const token = location.hash.slice(1)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [err, setErr] = useState<AppError | null>(
    token
      ? null
      : new AppError('invite-invalid', 'no invite token in the link'),
  )
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!token) return
    authed<Preview>('/invites/preview', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
      .then((p) => (p.member ? openHousehold(p.householdId) : setPreview(p)))
      .catch((e) => setErr(asInvite(e)))
  }, [token])

  async function join() {
    setBusy(true)
    try {
      const r = await authed<{ householdId: string }>('/invites/accept', {
        method: 'POST',
        body: JSON.stringify({ token }),
      })
      openHousehold(r.householdId)
    } catch (e) {
      setErr(asInvite(e))
      setBusy(false)
    }
  }

  if (err) return <ErrorView error={err} />
  if (!preview) return <p>Checking the invite…</p>
  return (
    <section>
      <h2>Join a household</h2>
      <p>
        You're invited to join <b>{preview.name ?? 'a household'}</b> as a
        member: you can watch on its gateways.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" disabled={busy} onClick={join}>
          Join
        </button>
        <button
          type="button"
          onClick={() => navigate({ to: '/', replace: true })}
        >
          Not now
        </button>
      </div>
    </section>
  )
}
