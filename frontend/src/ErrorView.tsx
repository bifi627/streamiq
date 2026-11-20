import { useEffect, useState, type HTMLAttributes, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { signOut } from '@firebase/auth'
import { auth } from './firebase'
import {
  AppError,
  describe,
  toAppError,
  type Action,
  type Kind,
} from './errors'

const label: Record<Action, string> = {
  retry: 'Retry',
  pair: 'Pair this browser',
  gateways: 'Gateways',
  'sign-in': 'Sign in again',
}

// 24×24 stroke icons (State's).
const ICON = {
  alert:
    'M12 8v5M12 16.5v.5M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  offline:
    'M2 8.8a15 15 0 0 1 4.2-2.6M10.7 5.1A15 15 0 0 1 22 8.8M5 12.9a10 10 0 0 1 5.2-2.7M19 12.9a10 10 0 0 0-2-1.4M8.5 16.4a5 5 0 0 1 7 0M12 20h.01M2 2l20 20',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  empty:
    'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z',
  gateway: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
}

/** The one empty / offline / error look: icon, one-line headline, a
 * plain line, then the actions (children: one button, at most one link). */
export function State({
  icon,
  title,
  text,
  loud,
  children,
  ...rest
}: {
  icon: keyof typeof ICON
  title: ReactNode
  text?: ReactNode
  loud?: boolean
  children?: ReactNode
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={loud ? 'state loud' : 'state'}>
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d={ICON[icon]} />
      </svg>
      <p className="state-title">{title}</p>
      {text && <p className="state-text">{text}</p>}
      {children}
    </div>
  )
}

const icon = (k: Kind): keyof typeof ICON =>
  k === 'gateway-offline' ||
  k === 'broker-unreachable' ||
  k === 'broker-lost' ||
  k === 'ice-failed' ||
  k === 'tunnel-lost' ||
  k === 'network'
    ? 'offline'
    : k === 'not-paired' ||
        k === 'pin-mismatch' ||
        k === 'gateway-refused' ||
        k === 'unauthorized' ||
        k === 'admin-only'
      ? 'lock'
      : 'alert'

/** The one way an error is shown, in the State look (data-kind for tests). Takes
 * anything thrown: non-AppErrors show as `unknown`. Retry defaults to a reload,
 * which reopens the gateway's session too. `pair` replaces the Pair action's link
 * to Gateways (null: the caller already offers it). `focus`: the button (else the
 * link) takes focus, for a state that is the whole page (one OK press on a remote). */
export function ErrorView({
  error: thrown,
  onRetry = () => location.reload(),
  pair,
  focus,
}: {
  error: unknown
  onRetry?: () => void
  pair?: ReactNode
  focus?: boolean
}) {
  const error = toAppError(thrown)
  const { message, actions, loud } = describe(error)
  const button = actions.includes('retry')
    ? 'retry'
    : actions.includes('sign-in')
      ? 'sign-in'
      : null
  const links = actions.filter(
    (a) => a === 'gateways' || (a === 'pair' && pair === undefined),
  )
  return (
    <State
      role="alert"
      data-kind={error.kind}
      icon={icon(error.kind)}
      loud={loud}
      title={message}
      text={error.message !== message && error.message}
    >
      {(button || links.length > 0) && (
        <p className="state-actions">
          {button && (
            <button
              type="button"
              className="primary"
              autoFocus={focus}
              onClick={button === 'retry' ? onRetry : () => signOut(auth)}
            >
              {label[button]}
            </button>
          )}
          {links.map((a, n) => (
            // Pairing lives on the Gateways list.
            <Link
              key={a}
              to="/gateways"
              autoFocus={focus && !button && n === 0}
            >
              {label[a]}
            </Link>
          ))}
        </p>
      )}
      {actions.includes('pair') && pair}
    </State>
  )
}

/** Safety net: errors that escaped every local catch, as a dismissible banner. */
export function UncaughtErrors() {
  const [error, setError] = useState<AppError | null>(null)
  useEffect(() => {
    const onError = (e: ErrorEvent) =>
      setError(toAppError(e.error ?? e.message))
    const onRejection = (e: PromiseRejectionEvent) =>
      setError(toAppError(e.reason))
    addEventListener('error', onError)
    addEventListener('unhandledrejection', onRejection)
    return () => {
      removeEventListener('error', onError)
      removeEventListener('unhandledrejection', onRejection)
    }
  }, [])
  if (!error) return null
  return (
    <div className="uncaught">
      <ErrorView error={error} />
      <button type="button" onClick={() => setError(null)}>
        Dismiss
      </button>
    </div>
  )
}
