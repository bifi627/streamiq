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
  useParams,
  useRouter,
} from '@tanstack/react-router'
import { auth } from './firebase'
import { getMe, takeNotice, type Me } from './api'
import { AppError, toAppError } from './errors'
import { ErrorView, UncaughtErrors } from './ErrorView'
import { Gateways } from './features/gateways/Gateways'
import {
  GatewayLibrary,
  ItemPage,
  LibraryHome,
  PlayerPage,
  RemotePage,
  ScreenPage,
} from './features/library/Library'
import { Diagnostics, DiagnosticsToggle } from './Diagnostics'
import {
  compatibleOn,
  lastGateway,
  rawOn,
  setCompatible,
  setLastGateway,
  setRaw,
  setTv,
  tvOn,
} from './settings'
import { arrowFocus } from './focus'
import { getGateways, type Gateway } from './features/gateways/api'
import { DiagnosticsPage } from './features/diagnostics/DiagnosticsPage'
import { Join } from './features/households/Invites'
import {
  HouseholdContext,
  householdLabel,
  switchHousehold,
} from './features/households/household'

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
    <main className="signin stack">
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
      <div className="buttons">
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
      {err && <p className="error">{err}</p>}
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
  const [tv, setTvOn] = useState(tvOn)
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
      <p className="muted">These apply to this device only.</p>
      <label className="setting">
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
      <p className="muted">
        For old TVs: plays everything in the safest format, costs more work on
        your home PC.
      </p>
      <label className="setting">
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
      <p className="muted">
        Adds Raw to the player's quality menu: no check of what this device can
        decode.
      </p>
      <label className="setting">
        <input
          type="checkbox"
          checked={tv}
          onChange={(e) => {
            setTv(e.target.checked)
            setTvOn(e.target.checked)
          }}
        />{' '}
        TV mode
      </label>
      <p className="muted">
        Larger text and a margin for TVs that crop the picture edges.
      </p>
      <DiagnosticsToggle />
      <p className="muted">
        Connection details on every page, to report a problem.
      </p>
      <p className="setting">
        {auth.currentUser?.email}{' '}
        <button type="button" onClick={() => signOut(auth)}>
          Sign out
        </button>
      </p>
    </section>
  )
}

// Root layout; only mounted while signed in (App gates the whole router). Loads
// /me once per page load and hands it to every view (HouseholdContext).
function Shell() {
  const [me, setMe] = useState<Me | null>(null)
  const [err, setErr] = useState<AppError | null>(null)
  // "You're no longer a member of …" after authed() dropped a lost household.
  const [notice, setNotice] = useState(takeNotice)
  useEffect(() => {
    getMe()
      .then(setMe)
      .catch((e) => setErr(toAppError(e))) // a lost household: authed() recovers
    // Another tab switched household: every request here now acts in it, so
    // reload home to keep this tab's views and role in step.
    const onStorage = (e: StorageEvent) =>
      e.key?.startsWith('streamiq.household.') && location.replace('/')
    addEventListener('storage', onStorage)
    return () => removeEventListener('storage', onStorage)
  }, [])

  // Gateway routes: that gateway's status chip. The Library link stays on other
  // routes too: the last opened gateway (per device), else the only one.
  // Fetched on entering/leaving a gateway. ponytail: online is as of then,
  // poll if it needs to be live.
  const { gatewayId } = useParams({ strict: false })
  const [gateways, setGateways] = useState<Gateway[]>([])
  const gateway = gateways.find((g) => g.id === gatewayId)
  useEffect(() => {
    if (gatewayId) setLastGateway(gatewayId)
    getGateways()
      .then(setGateways)
      .catch(() => {}) // the Gateways list / library show their own errors
  }, [gatewayId])
  const last = gateways.find((g) => g.id === lastGateway()) // gone = removed, or another household
  const libraryId =
    gatewayId ?? last?.id ?? (gateways.length === 1 ? gateways[0].id : null)

  return (
    <div className="shell">
      <header className="top">
        <span className="wordmark">
          Stream<span>IQ</span>
        </span>
        <nav className="nav" aria-label="Main" onKeyDown={arrowFocus}>
          <Link to="/" activeOptions={{ exact: true }}>
            Gateways
          </Link>
          {libraryId && (
            <Link to="/g/$gatewayId" params={{ gatewayId: libraryId }}>
              Library
            </Link>
          )}
          <Link to="/settings">Settings</Link>
        </nav>
        <span className="grow" />
        {me && me.memberships.length > 1 && (
          <select
            aria-label="Household"
            value={me.tenantId}
            onChange={(e) => switchHousehold(e.target.value)}
          >
            {me.memberships.map((m) => (
              <option key={m.id} value={m.id}>
                {householdLabel(m)} ({m.role})
              </option>
            ))}
          </select>
        )}
        {gatewayId && (
          <div className="status">
            <span className="chip">
              <span
                className={gateway?.online ? 'dot online' : 'dot'}
                aria-label={gateway?.online ? 'online' : 'offline'}
              />
              {gateway?.name ?? 'Gateway'}
            </span>
            <span className="meta muted">Your files stay on your hardware</span>
          </div>
        )}
      </header>
      <main>
        <Diagnostics />
        <UncaughtErrors />
        {notice && (
          <p role="status">
            {notice}{' '}
            <button type="button" onClick={() => setNotice(null)}>
              OK
            </button>
          </p>
        )}
        {err && <ErrorView error={err} />}
        <HouseholdContext.Provider value={me}>
          <Outlet />
        </HouseholdContext.Provider>
      </main>
    </div>
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
const remoteRoute = createRoute({
  getParentRoute: () => gatewayRoute,
  path: 'remote/$screenId',
  component: function Remote() {
    const { screenId } = remoteRoute.useParams()
    return <RemotePage key={screenId} screenId={screenId} />
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
    path: 'join',
    component: Join,
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
      path: 'screen',
      component: ScreenPage,
    }),
    remoteRoute,
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

  useEffect(() => {
    let was: User | null = null
    return onAuthStateChanged(auth, (u) => {
      // Signed out or another account: reload, so no open tunnel outlives the
      // account (the gateway plays it as that user's Jellyfin viewer, #195).
      if (was && was.uid !== u?.uid) return location.reload()
      was = u
      setUser(u)
      setReady(true)
    })
  }, [])

  if (!ready) return null
  // Signed out on a deep link: SignIn renders at that URL, so it loads after sign-in.
  return user ? <RouterProvider router={router} /> : <SignIn />
}
