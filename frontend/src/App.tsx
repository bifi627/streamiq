import { useEffect, useState } from 'react'
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  type User,
} from '@firebase/auth'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { auth } from './firebase'
import { getMe } from './api'
import { Gateways } from './features/gateways/Gateways'
import {
  GatewayLibrary,
  ItemPage,
  LibraryHome,
} from './features/library/Library'
import { Diagnostics, DiagnosticsToggle } from './Diagnostics'

// Readable text for the popup failures a user can cause; anything else keeps
// Firebase's message (still useful when reported).
const authErrors: Record<string, string> = {
  'auth/popup-closed-by-user': 'Sign-in window was closed before finishing.',
  'auth/cancelled-popup-request': 'Sign-in window was closed before finishing.',
  'auth/popup-blocked':
    'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.',
}
function authMessage(e: unknown) {
  const code = (e as { code?: string }).code
  return (
    (code && authErrors[code]) ?? (e instanceof Error ? e.message : String(e))
  )
}

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
      setErr(authMessage(e))
    }
  }

  async function google() {
    setErr(null)
    try {
      await signInWithPopup(auth, new GoogleAuthProvider())
    } catch (e) {
      setErr(authMessage(e))
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
      <button type="button" onClick={google}>
        Continue with Google
      </button>
      {err && <p style={{ color: 'crimson' }}>{err}</p>}
    </main>
  )
}

// Root layout; only mounted while signed in (App gates the whole router).
function Shell() {
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
        <span>{auth.currentUser?.email}</span>
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
      <Outlet />
    </main>
  )
}

// Code-based route tree. Client routes never start with /api or /healthz (the
// API serves index.html for everything else).
const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: () => (
    <p>
      Page not found. <Link to="/">Go to your gateways</Link>
    </p>
  ),
})
const gatewayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'g/$gatewayId',
  component: function Gateway() {
    const { gatewayId } = gatewayRoute.useParams()
    return <GatewayLibrary key={gatewayId} gatewayId={gatewayId} /> // new gateway = fresh tunnel state
  },
})
const itemRoute = createRoute({
  getParentRoute: () => gatewayRoute,
  path: 'i/$itemId',
  component: function Item() {
    const { itemId } = itemRoute.useParams()
    return <ItemPage key={itemId} itemId={itemId} />
  },
})
const routeTree = rootRoute.addChildren([
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: Gateways,
  }),
  gatewayRoute.addChildren([
    createRoute({
      getParentRoute: () => gatewayRoute,
      path: '/',
      component: LibraryHome,
    }),
    itemRoute,
  ]),
])
const router = createRouter({ routeTree })
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
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
  // Signed out on a deep link: SignIn renders at that URL, so it loads after sign-in.
  return user ? <RouterProvider router={router} /> : <SignIn />
}
