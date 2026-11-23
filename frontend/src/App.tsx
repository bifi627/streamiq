import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
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
import { auth } from './shared/firebase'
import { getMe, takeNotice, type Me } from './shared/api'
import { AppError, toAppError } from './shared/errors'
import { ErrorView, UncaughtErrors } from './shared/ErrorView'
import { Gateways, Home } from './features/gateways/Gateways'
import {
  GatewayLibrary,
  ItemPage,
  LibraryHome,
  PlayerPage,
} from './features/library/Library'
import { RemotePage, ScreenPage } from './features/screen/Screen'
import { Diagnostics } from './features/diagnostics/Diagnostics'
import {
  askTv,
  lastGateway,
  setLastGateway,
  TV_EVENT,
  tvOn,
} from './shared/settings'
import { TvAsk } from './features/tv/TvMode'
import { handoffHome, shellPage } from './features/tv/tvRoute'
import { chromeless, libraryTarget, screenTarget, tabs } from './shell'
import { Nav } from './Nav'
import { SlotsContext } from './shared/slots'
import { Handoff } from './features/tv/Handoff'
import { arrowFocus } from './shared/focus'
import { PickAlias } from './shared/Alias'
import { needsAlias, signingIn } from './shared/aliases'
import { clearArtThen } from './shared/leave'
import { useGateways } from './features/gateways/api'
import { GatewayBadge } from './features/gateways/Badge'
import { useQueryClient } from '@tanstack/react-query'
import { DiagnosticsPage } from './features/diagnostics/DiagnosticsPage'
import { Join } from './features/households/Invites'
import { Household, NoHousehold } from './features/households/HouseholdPage'
import { HouseholdContext, SetMeContext } from './features/households/household'
import { SignIn } from './features/signin/SignIn'
import { Settings } from './features/settings/Settings'
import { Activity } from './features/activity/Activity'
import { event } from './shared/diag'

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

  // The badge's gateway: the route's, else the Library tab's. Its dot is
  // as of entering/leaving a gateway route (refetched then).
  // ponytail: poll if online needs to be live.
  const { gatewayId } = useParams({ strict: false })
  const q = useGateways()
  const qc = useQueryClient()
  const gateways = q.data ?? []
  useEffect(() => {
    if (gatewayId) setLastGateway(gatewayId)
    // cancelRefetch false: joins the mount's fetch instead of a second one.
    void qc.refetchQueries({ queryKey: ['gateways'] }, { cancelRefetch: false })
  }, [gatewayId, qc])
  const library = libraryTarget(
    gatewayId,
    lastGateway(),
    gateways.map((g) => g.id),
  )
  const gateway = gateways.find((g) => g.id === library)
  // The dot: loading / failed are not "offline". The Gateways list /
  // library show their own errors.
  const dot = q.isPending
    ? 'loading'
    : q.isError
      ? 'failed'
      : gateway?.online
        ? 'online'
        : 'offline'
  const homeless = me !== null && me.tenantId === null
  const { pathname } = useLocation()
  const tv = useSyncExternalStore(onTvChange, tvOn)
  const home = handoffHome(tv, homeless)
  const page = {
    outlet: <Outlet />,
    noHousehold: <NoHousehold />,
    handoff: <Handoff url={location.href} home={home} />, // with /join's #<token>
    handoffHousehold: (
      <Handoff url={location.origin + '/household'} home={home} />
    ),
  }[shellPage(pathname, tv, homeless)]
  // The title row's parts, filled by the page (PageBar).
  const [back, setBack] = useState<HTMLElement | null>(null)
  const [title, setTitle] = useState<HTMLElement | null>(null)
  const [actions, setActions] = useState<HTMLElement | null>(null)
  const slots = useMemo(
    () => ({ back, title, actions }),
    [back, title, actions],
  )
  const bare = chromeless(pathname)
  const screen = !homeless && screenTarget(tv, library, pathname)

  return (
    // D-pad: an arrow no page container used (its edge, or a page
    // without one) moves across the whole shell, e.g. Up to the title row
    // and top bar, Down to the diagnostics dock. The player moves its own
    // focus (Controls.tsx).
    <div
      className="shell"
      onKeyDown={(e) =>
        !(e.target as Element).closest('.player') && arrowFocus(e)
      }
    >
      {!bare && (
        <header className="top">
          <Link to="/" className="wordmark" aria-label="StreamIQ home">
            Stream<span>IQ</span>
          </Link>
          <Nav tabs={tabs(tv, homeless)} library={library} />
          <span className="grow" />
          {screen && (
            <>
              <Link
                className="screen-btn"
                to="/g/$gatewayId/screen"
                params={{ gatewayId: screen }}
              >
                Use as screen
              </Link>
              <span className="grow" />
            </>
          )}
          {library && !homeless && (
            <GatewayBadge
              id={library}
              gateway={gateway}
              dot={dot}
              live={!!gatewayId}
            />
          )}
        </header>
      )}
      {!bare && (
        <div className="titlerow">
          <div ref={setBack} />
          <div ref={setTitle} className="titlerow-title" />
          <div ref={setActions} className="titlerow-actions" />
        </div>
      )}
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
          <SetMeContext.Provider value={setMe}>
            <SlotsContext.Provider value={slots}>{page}</SlotsContext.Provider>
          </SetMeContext.Provider>
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
        .catch((e) =>
          event(`sign-in: Google sign-in or name clear failed: ${e}`),
        )
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
