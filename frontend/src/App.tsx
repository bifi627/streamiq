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
  useCanGoBack,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { auth } from './firebase'
import { getMe } from './api'
import { AppError, toAppError } from './errors'
import { ErrorView, UncaughtErrors } from './ErrorView'
import { Gateways } from './features/gateways/Gateways'
import {
  GatewayLibrary,
  ItemPage,
  LibraryHome,
  PlayerPage,
} from './features/library/Library'
import { SpikePage } from './features/library/Spike'
import { Diagnostics, DiagnosticsToggle } from './Diagnostics'
import { compatibleOn, rawOn, setCompatible, setRaw } from './settings'
import { DiagnosticsPage } from './features/diagnostics/DiagnosticsPage'

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

// Per-device settings (#113). Back goes back in history; after a deep link
// (no in-app history) it goes home instead of leaving the app.
function Settings() {
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const navigate = useNavigate()
  const [compatible, setOn] = useState(compatibleOn)
  const [raw, setRawOn] = useState(rawOn)
  return (
    <section>
      <button
        type="button"
        onClick={() =>
          canGoBack
            ? router.history.back()
            : navigate({ to: '/', replace: true })
        }
      >
        Back
      </button>
      <h2>Settings</h2>
      <p style={{ color: '#888' }}>These apply to this device only.</p>
      <label>
        <input
          type="checkbox"
          autoFocus
          checked={compatible}
          onChange={(e) => {
            setCompatible(e.target.checked)
            setOn(e.target.checked)
          }}
        />{' '}
        Compatible mode
      </label>
      <p style={{ color: '#888', margin: '4px 0 0 24px' }}>
        For old TVs: plays everything in the safest format, costs more work on
        your home PC.
      </p>
      <label style={{ display: 'block', marginTop: 12 }}>
        <input
          type="checkbox"
          checked={raw}
          onChange={(e) => {
            setRaw(e.target.checked)
            setRawOn(e.target.checked)
          }}
        />{' '}
        Raw quality option (plays original streams, may not play on this device)
      </label>
      <p style={{ color: '#888', margin: '4px 0 0 24px' }}>
        Adds Raw to the player's quality menu: no check of what this device can
        decode.
      </p>
    </section>
  )
}

// Root layout; only mounted while signed in (App gates the whole router).
function Shell() {
  const navigate = useNavigate()
  const [tenantId, setTenantId] = useState('')
  const [err, setErr] = useState<AppError | null>(null)
  useEffect(() => {
    getMe()
      .then((m) => setTenantId(m.tenantId))
      .catch((e) => setErr(toAppError(e)))
  }, [])

  return (
    <main style={{ maxWidth: 960, margin: '2rem auto', padding: '0 1rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>{auth.currentUser?.email}</span>
        <span style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => navigate({ to: '/settings' })}>
            Settings
          </button>
          <DiagnosticsToggle />
          <button type="button" onClick={() => signOut(auth)}>
            Sign out
          </button>
        </span>
      </header>
      <Diagnostics />
      <UncaughtErrors />
      {err && <ErrorView error={err} />}
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
const playRoute = createRoute({
  getParentRoute: () => gatewayRoute,
  path: 'play/$itemId',
  component: function Play() {
    const { itemId } = playRoute.useParams()
    return <PlayerPage key={itemId} itemId={itemId} />
  },
})
const routeTree = rootRoute.addChildren([
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: Gateways,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: 'settings',
    component: Settings,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: 'diagnostics',
    component: DiagnosticsPage,
  }),
  gatewayRoute.addChildren([
    createRoute({
      getParentRoute: () => gatewayRoute,
      path: '/',
      component: LibraryHome,
    }),
    itemRoute,
    playRoute,
    createRoute({
      getParentRoute: () => gatewayRoute,
      path: 'spike',
      component: SpikePage,
    }),
  ]),
])
// Render errors in any route: the router's error boundary, shown like every
// other error (#45). reset re-renders the route.
const router = createRouter({
  routeTree,
  defaultErrorComponent: ({ error, reset }) => (
    <ErrorView error={error} onRetry={reset} />
  ),
})
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
