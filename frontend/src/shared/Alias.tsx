import { useId, useState, type FormEvent } from 'react'
import { signOut, updateProfile, type User } from '@firebase/auth'
import { auth } from './firebase'
import { describe, toAppError } from './errors'
import { arrowFocus } from './focus'
import { EditableName, STORED } from './EditableName'

// The alias other household members see instead of your email: the
// Firebase displayName, set here, never stored by us (no PII in our DB).

async function save(u: User, name: string) {
  try {
    await updateProfile(u, { displayName: name.trim() })
    return null
  } catch (e) {
    return describe(toAppError(e)).message
  }
}

// After sign-up, before the app: until a displayName is set (any device).
export function PickAlias({ user, done }: { user: User; done: () => void }) {
  const google = user.providerData.find((p) => p.providerId === 'google.com')
  const [name, setName] = useState(google?.displayName || user.email || '')
  const [err, setErr] = useState<string | null>(null)
  const hintId = useId()
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const e2 = await save(user, name)
    if (e2) setErr(e2)
    else done()
  }
  return (
    <main className="signin" onKeyDown={arrowFocus}>
      <header>
        <h1 className="wordmark">
          Stream<span>IQ</span>
        </h1>
        <p className="tagline">What should others call you?</p>
        <p className="muted">
          Members of your households see this name, not your email address. Keep
          this one or type another. You can change it in Settings.
        </p>
      </header>
      <form onSubmit={submit}>
        <label>
          Your name
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setErr(null)
            }}
            maxLength={100}
            required
            pattern=".*\S.*"
            autoFocus
            aria-describedby={hintId}
          />
        </label>
        <p id={hintId} className="hint muted">
          {STORED}
        </p>
        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
        <button type="submit" className="primary wide">
          Continue
        </button>
      </form>
      <p className="switch muted">
        Wrong account?{' '}
        <button type="button" className="link" onClick={() => signOut(auth)}>
          Sign out
        </button>
      </p>
    </main>
  )
}

// Settings → Account: change it later.
export function AliasSetting({ user }: { user: User }) {
  const [name, setName] = useState(user.displayName || user.email || '')
  return (
    <EditableName
      name={name}
      label="Your name"
      hint={STORED}
      rename={async (n) => {
        const e = await save(user, n)
        if (!e) setName(n)
        return e
      }}
    >
      <span className="setting">
        Your name <span className="muted">{name}</span>
      </span>
    </EditableName>
  )
}
