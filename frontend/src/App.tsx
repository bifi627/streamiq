import { useEffect, useState } from 'react'
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth'
import { auth } from './firebase'
import { getMe } from './api'
import { Gateways } from './features/gateways/Gateways'
import { Diagnostics, DiagnosticsToggle } from './Diagnostics'

function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)

  async function go(kind: 'in' | 'up') {
    setErr(null)
    try {
      const fn =
        kind === 'in'
          ? signInWithEmailAndPassword
          : createUserWithEmailAndPassword
      await fn(auth, email, password)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <main
      style={{ maxWidth: 320, margin: '4rem auto', display: 'grid', gap: 8 }}
    >
      <h1>StreamIQ</h1>
      <input
        placeholder="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <input
        placeholder="password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={() => go('in')}>
          Sign in
        </button>
        <button type="button" onClick={() => go('up')}>
          Create account
        </button>
      </div>
      {err && <p style={{ color: 'crimson' }}>{err}</p>}
    </main>
  )
}

function Shell({ user }: { user: User }) {
  const [tenantId, setTenantId] = useState('')
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    getMe()
      .then((m) => setTenantId(m.tenantId))
      .catch((e: Error) => setErr(e.message))
  }, [])

  return (
    <main style={{ maxWidth: 960, margin: '2rem auto', padding: '0 1rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>{user.email}</span>
        <span style={{ display: 'flex', gap: 8 }}>
          <DiagnosticsToggle />
          <button type="button" onClick={() => signOut(auth)}>
            Sign out
          </button>
        </span>
      </header>
      <Diagnostics />
      {err && <p style={{ color: 'crimson' }}>{err}</p>}
      <p style={{ color: '#888', fontSize: 12 }}>tenant {tenantId}</p>
      <Gateways />
    </main>
  )
}

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setUser(u)
        setReady(true)
      }),
    [],
  )

  if (!ready) return null
  return user ? <Shell user={user} /> : <SignIn />
}
