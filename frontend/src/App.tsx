import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
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
  useLocation,
  useNavigate,
  useParams,
  useRouter,
} from '@tanstack/react-router'
import { auth } from './firebase'
import { getMe, takeNotice, type Me } from './api'
import { AppError, toAppError } from './errors'
import { ErrorView, UncaughtErrors } from './ErrorView'
import { Gateways, Home } from './features/gateways/Gateways'
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
  dataSaver,
  dataSaverOn,
  lastGateway,
  netInfo,
  rawOn,
  setCompatible,
  setDataSaver,
  setLastGateway,
  setRaw,
  setTv,
  tvOn,
} from './settings'
import { arrowFocus } from './focus'
import {
  AliasSetting,
  needsAlias,
  PickAlias,
  signingIn,
  signInWithGoogle,
} from './Alias'
import { clearArtThen } from './leave'
import { useGateways } from './features/gateways/api'
import { useQueryClient } from '@tanstack/react-query'
import { DiagnosticsPage } from './features/diagnostics/DiagnosticsPage'
import { Join } from './features/households/Invites'
import { Household, NoHousehold } from './features/households/HouseholdPage'
import {
  HouseholdContext,
  SetMeContext,
  householdLabel,
  switchHousehold,
} from './features/households/household'
import { authMessage } from './authErrors'

function SignIn() {
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
    </main>
  )
}

// Per-device settings (#113), in sections (#229). Back goes back in history;
// after a deep link (no in-app history) it goes home instead of leaving the app.
function Settings() {
  const router = useRouter()
  const canGoBack = useCanGoBack()
  const navigate = useNavigate()
  const [compatible, setOn] = useState(compatibleOn)
  const [raw, setRawOn] = useState(rawOn)
  const [tv, setTvOn] = useState(tvOn)
  const [saver, setSaver] = useState(dataSaver)
  const net = netInfo()
  return (
    <section className="settings" onKeyDown={arrowFocus}>
      <button
        type="button"
        className="back"
        onClick={() =>
          canGoBack
            ? router.history.back()
            : navigate({ to: '/', replace: true })
        }
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M15 6l-6 6 6 6" />
        </svg>
        Back
      </button>
      <div className="head">
        <h1>Settings</h1>
        <p className="muted">These apply to this device only.</p>
      </div>

      <div className="card">
        <h2>Playback</h2>
        <ul className="rows">
          <li>
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
              For old TVs: plays everything in the safest format, costs more
              work on your home PC.
            </p>
          </li>
          <li>
            {/* Buttons, not a select: a select keeps the D-pad's arrows
                (focus.ts), so focus could never leave it (#229). */}
            <div className="setting">
              <span id="saver">Data saver</span>
              <div role="group" aria-labelledby="saver" className="choice">
                {(
                  [
                    ['auto', 'Automatic'],
                    ['on', 'On'],
                    ['off', 'Off'],
                  ] as const
                ).map(([v, name]) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={saver === v}
                    onClick={() => {
                      setDataSaver(v)
                      setSaver(v)
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
            <p className="muted">
              {dataSaverOn() ? 'On now' : 'Off now'}: Auto quality stays at 480p
              and the speed test uses ~3 MB instead of up to ~50 MB. Automatic
              turns it on on mobile data or when the browser asks to save data.
              This browser reports:{' '}
              {net
                ? `connection ${net.type ?? 'unknown'}, save data ${net.saveData ? 'on' : 'off'}`
                : 'nothing (no Network Information API)'}
              .
            </p>
          </li>
          <li>
            <label className="setting">
              <input
                type="checkbox"
                checked={raw}
                onChange={(e) => {
                  setRaw(e.target.checked)
                  setRawOn(e.target.checked)
                }}
              />{' '}
              Raw quality option
            </label>
            <p className="muted">
              Adds Raw to the player's quality menu: plays original streams with
              no check of what this device can decode, so they may not play.
            </p>
          </li>
        </ul>
      </div>

      <div className="card">
        <h2>Display</h2>
        <ul className="rows">
          <li>
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
          </li>
        </ul>
      </div>

      <div className="card">
        <h2>Account</h2>
        <ul className="rows">
          {auth.currentUser && (
            <li>
              <AliasSetting user={auth.currentUser} />
              <p className="muted">
                What members of your households see instead of your email.
              </p>
            </li>
          )}
          <li>
            <span className="setting">
              Signed in as{' '}
              <span className="muted">{auth.currentUser?.email}</span>
            </span>
            <button type="button" onClick={() => signOut(auth)}>
              Sign out
            </button>
          </li>
        </ul>
      </div>

      <div className="card">
        <h2>Diagnostics</h2>
        <ul className="rows">
          <li>
            <DiagnosticsToggle />
            <p className="muted">
              Connection, CPU and memory details on every page, to report a
              problem.
            </p>
          </li>
          <li>
            <Link to="/diagnostics">Client info + connection test</Link>
            <p className="muted">
              What this browser can play, and a speed test to your gateway.
            </p>
          </li>
        </ul>
      </div>
    </section>
  )
}

// Root layout; only mounted while signed in (App gates the whole router). Loads
// /me once per page load and hands it to every view (HouseholdContext).
// oxlint-disable-next-line complexity -- render branching
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
  // Refetched on entering/leaving a gateway. ponytail: online is as of then,
  // poll if it needs to be live.
  const { gatewayId } = useParams({ strict: false })
  const q = useGateways()
  const qc = useQueryClient()
  const gateways = q.data ?? []
  const gateway = gateways.find((g) => g.id === gatewayId)
  useEffect(() => {
    if (gatewayId) setLastGateway(gatewayId)
    // cancelRefetch false: joins the mount's fetch instead of a second one.
    void qc.refetchQueries({ queryKey: ['gateways'] }, { cancelRefetch: false })
  }, [gatewayId, qc])
  // The chip's dot (#206): loading / failed are not "offline". The Gateways
  // list / library show their own errors.
  const dot = q.isPending
    ? 'loading'
    : q.isError
      ? 'failed'
      : gateway?.online
        ? 'online'
        : 'offline'
  const last = gateways.find((g) => g.id === lastGateway()) // gone = removed, or another household
  const libraryId =
    gatewayId ?? last?.id ?? (gateways.length === 1 ? gateways[0].id : null)
  // In no household (#387): only Settings and /join (the way in) still open;
  // every other page is household-scoped, the no-household screen stands in.
  const homeless = me !== null && me.tenantId === null
  const { pathname } = useLocation()
  const page =
    homeless && pathname !== '/settings' && pathname !== '/join' ? (
      <NoHousehold />
    ) : (
      <Outlet />
    )

  return (
    // D-pad (#230): an arrow no page container used (its edge, or a page
    // without one) moves across the whole shell, e.g. Down to the diagnostics
    // dock. The player moves its own focus (Controls.tsx).
    <div
      className="shell"
      onKeyDown={(e) =>
        !(e.target as Element).closest('.player') && arrowFocus(e)
      }
    >
      <header className="top">
        <span className="wordmark">
          Stream<span>IQ</span>
        </span>
        <nav className="nav" aria-label="Main" onKeyDown={arrowFocus}>
          {!homeless && <Link to="/gateways">Gateways</Link>}
          {libraryId && !homeless && (
            <Link to="/g/$gatewayId" params={{ gatewayId: libraryId }}>
              Library
            </Link>
          )}
          <Link to="/household">Household</Link>
          <Link to="/settings">Settings</Link>
        </nav>
        <span className="grow" />
        {me && me.memberships.length > 1 && (
          <select
            aria-label="Switch household"
            value={me.tenantId ?? ''}
            onChange={(e) => switchHousehold(e.target.value)}
          >
            {me.memberships.map((m) => (
              <option key={m.id} value={m.id}>
                {householdLabel(m)} ({m.role})
              </option>
            ))}
          </select>
        )}
        {gatewayId && !homeless && (
          <div className="status">
            <span className="chip">
              <span
                className={`dot ${dot}`}
                role="img"
                aria-label={dot === 'failed' ? 'status unavailable' : dot}
              />
              {gateway?.name ?? 'Gateway'}
              {dot === 'failed' && (
                <span className="muted" aria-hidden="true">
                  · status unavailable
                </span>
              )}
            </span>
            <span className="meta muted">Your files stay on your hardware</span>
          </div>
        )}
      </header>
      <main>
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
          <SetMeContext.Provider value={setMe}>{page}</SetMeContext.Provider>
        </HouseholdContext.Provider>
      </main>
      <Diagnostics />
    </div>
  )
}

// Code-based route tree. Client routes never start with /api or /healthz (the
// API serves index.html for everything else).
const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: () => (
    <p>
      Page not found. <Link to="/gateways">Go to your gateways</Link>
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
    component: Home,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: 'gateways',
    component: Gateways,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: 'settings',
    component: Settings,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: 'household',
    component: Household,
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
  const [, aliasSet] = useState(false) // updateProfile fires no auth event

  useEffect(() => {
    let was: User | null = null
    return onAuthStateChanged(auth, (u) => {
      // Signed out or another account: reload, so no open tunnel outlives the
      // account (the gateway plays it as that user's Jellyfin viewer, #195);
      // the artwork caches go with it (#203).
      if (was && was.uid !== u?.uid)
        return clearArtThen(() => location.reload())
      was = u
      // A Google sign-up clears its Google name first (#404).
      void signingIn
        .catch(() => {})
        .then(() => {
          setUser(u)
          setReady(true)
        })
    })
  }, [])

  if (!ready) return null
  // Signed out on a deep link: SignIn renders at that URL, so it loads after sign-in.
  if (!user) return <SignIn />
  if (needsAlias(user))
    return <PickAlias user={user} done={() => aliasSet(true)} />
  return <RouterProvider router={router} />
}
