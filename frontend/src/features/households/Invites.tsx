import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { authed } from '../../api'
import { switchHousehold } from './household'
import { AppError, toAppError } from '../../errors'
import { ErrorView } from '../../ErrorView'
import { arrowFocus } from '../../focus'

type Invite = { id: string; createdAt: string; expiresAt: string }
type Preview = { householdId: string; name: string | null; member: boolean }

// The token lives in the link's fragment (/join#<token>): never sent to a server
// as a URL, so it can't land in access logs. The API gets it in a POST body.
const linkFor = (token: string) => `${location.origin}/join#${token}`

// Invites of the current household (admin-only, #191): create a single-use link
// (7 days), list the pending ones, revoke one. The link is shown once: Copy, or
// Share through the phone's apps (Web Share; absent on TVs and plain http).
export function Invites() {
  const [invites, setInvites] = useState<Invite[]>([])
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(
    null,
  )
  const [copied, setCopied] = useState(false)
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
      setCopied(false)
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

  // No clipboard API on plain http (a LAN address): the link selects on click.
  const copy = (url: string) =>
    navigator.clipboard
      ?.writeText(url)
      .then(() => setCopied(true))
      .catch(() => {})
  const share = (url: string) =>
    navigator
      .share({ title: 'Join my StreamIQ household', url })
      .catch(() => {}) // closed the share sheet

  return (
    <section className="card">
      <div className="card-head">
        <h2>Invites</h2>
        <button type="button" className="primary" onClick={create}>
          Invite someone
        </button>
      </div>
      {err && <ErrorView error={err} />}
      {link && (
        <div className="pair-box invite-link">
          <p>
            Send this link to the person you invite. It works once and expires{' '}
            {new Date(link.expiresAt).toLocaleString()}.
          </p>
          <pre>{link.url}</pre>
          <div className="actions">
            <button type="button" onClick={() => copy(link.url)}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
            {'share' in navigator && (
              <button type="button" onClick={() => share(link.url)}>
                Share…
              </button>
            )}
          </div>
        </div>
      )}
      {invites.length > 0 ? (
        <ul className="rows">
          {invites.map((i) => (
            <li key={i.id}>
              <span className="who">
                <b>Pending invite</b>
                <span className="meta muted">
                  Created {new Date(i.createdAt).toLocaleString()} · expires{' '}
                  {new Date(i.expiresAt).toLocaleString()}
                </span>
              </span>
              <span className="row-actions">
                <button type="button" onClick={() => revoke(i.id)}>
                  Revoke
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        !link && (
          <p className="meta muted">
            No open invites. An invite link works once and for 7 days.
          </p>
        )
      )}
    </section>
  )
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
      .then((p) => (p.member ? switchHousehold(p.householdId) : setPreview(p)))
      .catch((e) => setErr(asInvite(e)))
  }, [token])

  async function join() {
    setBusy(true)
    try {
      const r = await authed<{ householdId: string }>('/invites/accept', {
        method: 'POST',
        body: JSON.stringify({ token }),
      })
      switchHousehold(r.householdId)
    } catch (e) {
      setErr(asInvite(e))
      setBusy(false)
    }
  }

  return (
    <section className="card join" onKeyDown={arrowFocus}>
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M3 11l9-7 9 7M5 10v10h14V10" />
      </svg>
      {err ? (
        <ErrorView error={err} />
      ) : !preview ? (
        <p className="muted">Checking the invite…</p>
      ) : (
        <>
          <h1>Join {preview.name ?? 'a household'}</h1>
          <p className="muted">
            You're invited as a member: you can watch on its gateways.
          </p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              autoFocus
              disabled={busy}
              onClick={join}
            >
              Join
            </button>
            <button
              type="button"
              onClick={() => navigate({ to: '/', replace: true })}
            >
              Not now
            </button>
          </div>
        </>
      )}
    </section>
  )
}
