import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { authed } from '../../shared/api'
import { copyText } from '../../shared/clipboard'
import { switchHousehold } from './household'
import { AppError, toAppError } from '../../shared/errors'
import { ErrorView } from '../../shared/ErrorView'
import { arrowFocus } from '../../shared/focus'
import { event } from '../../shared/diag'
import type {
  Accepted,
  Created,
  Invite,
  Preview,
} from '../../generated/invites'

// The token lives in the link's fragment (/join#<token>): never sent to a server
// as a URL, so it can't land in access logs. The API gets it in a POST body.
const linkFor = (token: string) => `${location.origin}/join#${token}`

// Invites of the current household (admin-only): create a single-use link
// (7 days), list the pending ones, revoke one. The link is shown once: Copy, or
// Share through the phone's apps (Web Share; absent on TVs and plain http).
export function Invites() {
  const q = useQuery({
    queryKey: ['invites'],
    queryFn: () => authed<Invite[]>('/invites'),
  })
  const invites = q.data ?? []
  const [link, setLink] = useState<{
    id: string
    url: string
    expiresAt: string
  } | null>(null)
  const [copied, setCopied] = useState(false)
  const [actErr, setErr] = useState<AppError | null>(null)
  const err = actErr ?? (q.error && toAppError(q.error))
  const loaded = q.isSuccess // "No open invites" only after a load
  const inviteBtn = useRef<HTMLButtonElement>(null)
  const qc = useQueryClient()
  const reload = () => qc.invalidateQueries({ queryKey: ['invites'] })

  const creating = useMutation({
    mutationFn: () =>
      authed<Created>('/invites', {
        method: 'POST',
      }),
    onMutate: () => setErr(null),
    onSuccess: (r) => {
      setLink({ id: r.id, url: linkFor(r.token), expiresAt: r.expiresAt })
      setCopied(false)
      return reload()
    },
    onError: (e) => setErr(toAppError(e)),
  })

  const revoking = useMutation({
    mutationFn: (id: string) => authed(`/invites/${id}`, { method: 'DELETE' }),
    onMutate: () => setErr(null),
    onSuccess: (_, id) => {
      if (id === link?.id) setLink(null) // its link box goes with it
      // Revoke goes with its row: focus a control that stays, or the D-pad
      // (arrowFocus on the page) loses its place, as in Pairing.
      inviteBtn.current?.focus()
      return reload()
    },
    onError: (e) => setErr(toAppError(e)),
  })

  // No clipboard API on plain http (a LAN address): the link selects on click.
  const copy = (url: string) =>
    copyText(url).then((ok) => ok && setCopied(true))
  const share = (url: string) =>
    navigator
      .share({ title: 'Join my StreamIQ household', url })
      .catch((e) => event(`invite: share closed or failed: ${e}`))

  return (
    <section className="card">
      <div className="card-head">
        <h2>Invites</h2>
        <button
          ref={inviteBtn}
          type="button"
          className="primary"
          onClick={() => creating.mutate()}
        >
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
                <button type="button" onClick={() => revoking.mutate(i.id)}>
                  Revoke
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        loaded &&
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
      const r = await authed<Accepted>('/invites/accept', {
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
