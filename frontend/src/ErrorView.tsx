import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { signOut } from '@firebase/auth'
import { auth } from './firebase'
import { AppError, describe, toAppError, type Action } from './errors'

const label: Record<Action, string> = {
  retry: 'Retry',
  pair: 'Pair this browser',
  gateways: 'Gateways',
  'sign-in': 'Sign in again',
}

/** The one way an error is shown (#45). data-kind lets tests assert the kind.
 * Retry defaults to a reload: it reopens the gateway's session too. */
export function ErrorView({
  error,
  onRetry = () => location.reload(),
}: {
  error: AppError
  onRetry?: () => void
}) {
  const { message, actions, loud } = describe(error)
  return (
    <div
      role="alert"
      data-kind={error.kind}
      style={
        loud
          ? { color: 'white', background: 'crimson', padding: '0.5rem' }
          : { color: 'crimson' }
      }
    >
      <p style={{ margin: '0.5rem 0' }}>
        {loud ? <b>{message}</b> : message}{' '}
        {actions.map((a) =>
          a === 'retry' ? (
            <button key={a} type="button" onClick={onRetry}>
              {label[a]}
            </button>
          ) : a === 'sign-in' ? (
            <button key={a} type="button" onClick={() => signOut(auth)}>
              {label[a]}
            </button>
          ) : (
            // Pairing lives on the Gateways list.
            <Link key={a} to="/">
              {label[a]}
            </Link>
          ),
        )}
      </p>
      {error.message !== message && (
        <p style={{ margin: 0, fontSize: 12, opacity: 0.8 }}>{error.message}</p>
      )}
    </div>
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
    <div style={{ display: 'flex', gap: 8, alignItems: 'start' }}>
      <ErrorView error={error} />
      <button type="button" onClick={() => setError(null)}>
        Dismiss
      </button>
    </div>
  )
}
