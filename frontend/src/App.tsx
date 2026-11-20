import { useEffect, useState, useSyncExternalStore } from 'react'
import { onAuthStateChanged, type User } from '@firebase/auth'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useLocation,
  useParams,
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
} from './features/library/Library'
import { RemotePage, ScreenPage } from './features/library/Screen'
import { Diagnostics } from './Diagnostics'
import { askTv, lastGateway, setLastGateway, TV_EVENT, tvOn } from './settings'
import { TvAsk } from './TvMode'
import { handoffHome, shellPage, tvRoute } from './tvRoute'
import { Handoff } from './Handoff'
import { arrowFocus } from './focus'
import { needsAlias, PickAlias, signingIn } from './Alias'
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
import { SignIn } from './features/signin/SignIn'
import { Settings } from './features/settings/Settings'
import { Activity } from './features/activity/Activity'

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
  // The chip's dot: loading / failed are not "offline". The Gateways
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
  const homeless = me !== null && me.tenantId === null
  const { pathname } = useLocation()
  const tv = useSyncExternalStore(onTvChange, tvOn)
  const navOk = (path: string) => !tv || tvRoute(path) === 'allow'
  const home = handoffHome(tv, homeless)
  const page = {
    outlet: <Outlet />,
    noHousehold: <NoHousehold />,
    handoff: <Handoff url={location.href} home={home} />, // with /join's #<token>
    handoffHousehold: (
      <Handoff url={location.origin + '/household'} home={home} />
    ),
  }[shellPage(pathname, tv, homeless)]

  return (
    // D-pad: an arrow no page container used (its edge, or a page
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
          {!homeless && navOk('/activity') && (
            <Link to="/activity">Activity</Link>
          )}
          {libraryId && !homeless && (
            <Link to="/g/$gatewayId" params={{ gatewayId: libraryId }}>
              Library
            </Link>
          )}
          {navOk('/household') && <Link to="/household">Household</Link>}
          {navOk('/settings') && <Link to="/settings">Settings</Link>}
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

const onTvChange = (cb: () => void) => {
  addEventListener(TV_EVENT, cb)
  return () => removeEventListener(TV_EVENT, cb)
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
    path: 'activity',
    component: Activity,
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
// other error. reset re-renders the route.
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
  const [ask, setAsk] = useState(askTv)

  useEffect(() => {
    let was: User | null = null
    return onAuthStateChanged(auth, (u) => {
      // Signed out or another account: reload, so no open tunnel outlives the
      // account (the gateway plays it as that user's Jellyfin viewer);
      // the artwork caches go with it.
      if (was && was.uid !== u?.uid)
        return clearArtThen(() => location.reload())
      was = u
      // A Google sign-up clears its Google name first.
      void signingIn
        .catch(() => {})
        .then(() => {
          setUser(u)
          setReady(true)
        })
    })
  }, [])

  if (ask) return <TvAsk done={() => setAsk(false)} />
  if (!ready) return null
  // Signed out on a deep link: SignIn renders at that URL, so it loads after sign-in.
  if (!user) return <SignIn />
  if (needsAlias(user))
    return <PickAlias user={user} done={() => aliasSet(true)} />
  return <RouterProvider router={router} />
}
