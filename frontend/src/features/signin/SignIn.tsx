import { useRef, useState, type FormEvent } from 'react'
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from '@firebase/auth'
import { auth } from '../../firebase'
import { arrowFocus } from '../../focus'
import { signInWithGoogle } from '../../Alias'
import { authMessage } from '../../authErrors'
import { TvToggle } from '../../Tv'

// The signed-out page: Google or email + password, sign in or sign up.
export function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [signUp, setSignUp] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // A ref, not the state: a second Enter can land before the re-render.
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)

  async function run(f: () => Promise<unknown>) {
    setErr(null)
    try {
      await f()
    } catch (e) {
      setErr(authMessage(e))
    }
  }

  // Only the form is locked: Firebase reports a closed Google popup up to
  // ~18 s late, and a second Google click already replaces the pending popup.
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    const fn = signUp
      ? createUserWithEmailAndPassword
      : signInWithEmailAndPassword
    await run(() => fn(auth, email, password))
    busyRef.current = false
    setBusy(false)
  }

  return (
    <main className="signin" onKeyDown={arrowFocus}>
      <header>
        <h1 className="wordmark">
          Stream<span>IQ</span>
        </h1>
        <p className="tagline">Your home media, anywhere.</p>
        <p className="privacy muted">
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M3 11l9-7 9 7M5 10v10h14V10" />
          </svg>
          Your files never leave your hardware.
        </p>
      </header>
      <button
        type="button"
        className="wide google"
        onClick={() => run(signInWithGoogle)}
      >
        {/* Google's "G" (their sign-in button branding, dark theme) */}
        <svg aria-hidden="true" viewBox="0 0 48 48">
          <path
            fill="#EA4335"
            d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
          />
          <path
            fill="#4285F4"
            d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
          />
          <path
            fill="#FBBC05"
            d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
          />
          <path
            fill="#34A853"
            d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
          />
        </svg>
        Continue with Google
      </button>
      <div className="or meta muted">or</div>
      {/* noValidate: a bad email gets our inline error, not the browser's pop-up */}
      <form onSubmit={submit} noValidate>
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label htmlFor="password">Password</label>
        <div className="password">
          <input
            id="password"
            type={show ? 'text' : 'password'}
            autoComplete={signUp ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            aria-label={show ? 'Hide password' : 'Show password'}
            onClick={() => setShow(!show)}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
              <circle cx="12" cy="12" r="3" />
              {show && <path d="M3 3l18 18" />}
            </svg>
          </button>
        </div>
        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
        <button type="submit" className="primary wide" aria-disabled={busy}>
          {signUp ? 'Create account' : 'Sign in'}
        </button>
      </form>
      <p className="switch muted">
        {signUp ? 'Have an account?' : 'New here?'}{' '}
        <button
          type="button"
          className="link"
          onClick={() => {
            setSignUp(!signUp)
            setErr(null)
          }}
        >
          {signUp ? 'Sign in instead' : 'Create an account'}
        </button>
      </p>
      <div className="tv-toggle muted">
        <TvToggle />
      </div>
    </main>
  )
}
