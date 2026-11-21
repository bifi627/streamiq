// The screen feature: a TV in screen mode, the phone's "Play on…"
// and its remote. Routes in App.tsx; the remote's decisions live in remote.ts.
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Link,
  useCanGoBack,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { browserName } from '../pairing/connect'
import { toAppError } from '../../errors'
import * as jf from './jellyfin'
import { event } from '../../diag'
import {
  clientsOn,
  commandScreen,
  postScreenState,
  screenFeed,
  screensOn,
  type Screen,
  type ScreenCommand,
  type ScreenState,
} from '../gateways/api'
import { clampSeek, polled } from './remote'
import { serial } from './serial'
import { Player } from './Player'
import {
  audioTracks,
  clock,
  isBack,
  subtitleTracks,
  TICKS_PER_SECOND,
  type Item,
} from './items'
import { ICON, Icon } from './Controls'
import { Tunnel, backdrop, primary, useTunnelQuery } from './art'
import { useScreens } from './queries'
import { Artwork } from './Home'

// Screen mode (docs/protocol.md "Screens"): this device holds GET
// /streamiq/screen and plays what a phone on the same gateway sends. The screen
// lives as long as this view: leaving it (Back, tab closed) closes the channel,
// which removes the screen on the gateway; leaving the gateway frees the
// shared session. No devtools on a TV: everything goes to the diagnostics log.
export function ScreenPage() {
  const { gatewayId, pc, speed } = useContext(Tunnel)
  const navigate = useNavigate()
  const [play, setPlay] = useState<{
    itemId: string
    startTicks?: number
    n: number
  } | null>(null)
  const [ended, setEnded] = useState<string | null>(null)
  const players = useRef(new Set<(c: ScreenCommand) => void>())
  // Commands between a play and its Player's subscribe, replayed to it
  // (StrictMode subscribes twice in one commit); then null: live only.
  const since = useRef<ScreenCommand[] | null>(null)
  const remote = useCallback((apply: (c: ScreenCommand) => void) => {
    players.current.add(apply)
    const early = since.current
    early?.forEach(apply)
    setTimeout(() => {
      if (since.current === early) since.current = null
    })
    return () => void players.current.delete(apply)
  }, [])
  // State to the gateway: one POST at a time, in order; while one is
  // out, only the newest waits.
  const post = useMemo(
    () =>
      serial(
        (s: ScreenState) => postScreenState(pc, s),
        () => true,
      ),
    [pc],
  )
  const router = useRouter()
  const canGoBack = useCanGoBack()
  // Pops the screen off history (or replaces it), so a later Back never
  // lands on it and reopens a screen the user didn't choose.
  const leave = useCallback(
    () =>
      canGoBack
        ? router.history.back()
        : navigate({
            to: '/g/$gatewayId',
            params: { gatewayId },
            replace: true,
          }),
    [router, canGoBack, navigate, gatewayId],
  )
  useEffect(() => {
    const active = () =>
      (navigator as { userActivation?: { hasBeenActive: boolean } })
        .userActivation?.hasBeenActive ?? '?'
    event(
      `screen: open · ${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? navigator.userAgent} · user activation ${active()}`,
    )
    // Screen saver / power saving may freeze the page: log for how long.
    let last = Date.now()
    const watchdog = setInterval(() => {
      const gap = Date.now() - last
      if (gap > 30_000)
        event(`screen: page frozen ~${Math.round(gap / 1000)} s`)
      last = Date.now()
    }, 5_000)
    let n = 0
    const close = screenFeed(
      pc,
      (c) => {
        event(`screen: ${c.type} · user activation ${active()}`)
        if (c.type === 'play') {
          players.current.clear() // the old Player is on its way out
          since.current = []
          setPlay({ itemId: c.itemId, startTicks: c.startTicks, n: ++n })
        } else if (c.type === 'stop') setPlay(null)
        else {
          since.current?.push(c)
          players.current.forEach((apply) => apply(c))
        }
      },
      (why) => {
        event(`screen: ended (${why})`)
        setEnded(why)
      },
    )
    return () => {
      clearInterval(watchdog)
      close()
    }
  }, [pc])
  useEffect(() => {
    if (!play) post(IDLE)
  }, [play, post])
  // The remote's Back on the waiting view; the player handles its own.
  useEffect(() => {
    if (play) return
    const key = (e: KeyboardEvent) => {
      if (!isBack(e)) return
      e.preventDefault() // else the browser's own Back runs too
      leave()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [play, leave])

  // The name the gateway stores, so a rename shows here too: it's what
  // the phone's Play on list offers. The auto name until it answers (older gateway).
  const [name, setName] = useState(browserName)
  useEffect(() => {
    clientsOn(pc).then(
      (l) => {
        const me = l.find((c) => c.self)
        if (me) setName(me.name)
      },
      (e) => event(`screen: own client name failed: ${e}`),
    )
  }, [pc])
  return (
    <>
      {ended && (
        <p role="alert">
          Screen mode ended ({ended}).{' '}
          <Link to="/gateways">Back to your gateways</Link> and open it again.
        </p>
      )}
      {play ? (
        <>
          <p className="muted">
            <small>📱 Controlled from your phone</small>
          </p>
          <Player
            key={play.n}
            pc={pc}
            speed={speed}
            itemId={play.itemId}
            startTicks={play.startTicks}
            remote={remote}
            onState={post}
            onExit={() => setPlay(null)}
          />
        </>
      ) : (
        !ended && (
          // Read from the couch: big, centered, one action.
          <div className="screen-wait">
            <Icon d={ICON.tv} />
            <h2>Screen: {name}</h2>
            <ol>
              <li>Open StreamIQ on your phone</li>
              <li>Pick something to watch</li>
              <li>
                Play on <b>{name}</b>
              </li>
            </ol>
            <button type="button" autoFocus onClick={leave}>
              Leave
            </button>
          </div>
        )
      )}
    </>
  )
}

// "Play on…": the gateway's open screens. Only a device in screen mode
// is one, so nothing else can be picked.
export function PlayOn({ pc, item }: { pc: RTCPeerConnection; item: Item }) {
  const { gatewayId } = useContext(Tunnel)
  const navigate = useNavigate()
  const [screens, setScreens] = useState<Screen[] | null>(null)
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState('')
  const toggle = () => {
    setOpen(!open)
    setScreens(null)
    setMsg('')
    if (!open)
      screensOn(pc).then(setScreens, (e) => setMsg(toAppError(e).message))
  }
  const send = (s: Screen) => {
    // No startTicks: the TV resumes from fresh UserData (this listing may be stale).
    const play: ScreenCommand = {
      type: 'play',
      itemId: item.Id,
    }
    commandScreen(pc, s.id, play).then(
      () =>
        navigate({
          to: '/g/$gatewayId/remote/$screenId',
          params: { gatewayId, screenId: s.id },
        }),
      (e) => setMsg(toAppError(e).message),
    )
  }
  return (
    // A secondary action under the tile: outlined, not filled.
    <div className="play-on">
      <button
        type="button"
        className="secondary"
        onClick={toggle}
        aria-expanded={open}
      >
        <Icon d={ICON.cast} />
        Play on…
      </button>
      {open &&
        screens &&
        (screens.length ? (
          <ul>
            {screens.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => send(s)}>
                  {s.name}
                </button>
                {s.state?.itemId && (
                  <Link
                    to="/g/$gatewayId/remote/$screenId"
                    params={{ gatewayId, screenId: s.id }}
                  >
                    Remote
                  </Link>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">
            <small>
              No screen open. On the TV, go to Gateways in StreamIQ and choose
              “Use as screen” on this gateway.
            </small>
          </p>
        ))}
      {msg && (
        <p>
          <small>{msg}</small>
        </p>
      )}
    </div>
  )
}

const IDLE: ScreenState = {
  itemId: '',
  positionTicks: 0,
  durationTicks: 0,
  paused: true,
  audio: null,
  subtitle: null,
}

// Phone remote view: follows the screen's state (GET /streamiq/screens
// every second) and sends commands one at a time, in order (each POST is its
// own channel). Two phones see the same state; the last command wins.
export function RemotePage({ screenId }: { screenId: string }) {
  const { gatewayId, pc } = useContext(Tunnel)
  const [msg, setMsg] = useState('') // the last command's error
  const q = useScreens(gatewayId, pc, screenId)
  const down = q.error ? toAppError(q.error).message : '' // the last poll's
  const [wasDown, setWasDown] = useState('')
  const { screen, recovered } = polled(screenId, q.data, down, wasDown)
  if (down !== wasDown) {
    setWasDown(down)
    if (recovered) setMsg('') // a command error from the outage is stale
  }
  // A drag sends many seeks: a queued seek is replaced by the newer one.
  const send = useMemo(
    () =>
      serial(
        (c: ScreenCommand) =>
          commandScreen(pc, screenId, c).then(
            () => setMsg(''), // a command that works clears the last one's error
            (e) => setMsg(toAppError(e).message),
          ),
        (queued, c) => queued.type === 'seek' && c.type === 'seek',
      ),
    [pc, screenId],
  )

  if (screen === undefined)
    return <p className="remote">{down || 'Connecting to the screen…'}</p>
  const library = (
    <Link to="/g/$gatewayId" params={{ gatewayId }}>
      Library
    </Link>
  )
  if (!screen)
    return (
      <div className="remote">
        <p role="alert">Screen closed. {library}</p>
      </div>
    )
  const st = screen.state
  // Phone first: one column, the keys low enough for a thumb.
  return (
    <div className="remote">
      <h2>
        <Icon d={ICON.tv} />
        Remote: {screen.name}
      </h2>
      {st?.itemId ? (
        <Playing key={st.itemId} st={st} send={send} />
      ) : (
        <p>Nothing playing. {library}</p>
      )}
      {(down || msg) && (
        <p>
          <small>{down || msg}</small>
        </p>
      )}
    </div>
  )
}

// The remote while the screen plays st.itemId: art, seek bar, keys, tracks.
function Playing({
  st,
  send,
}: {
  st: ScreenState
  send: (c: ScreenCommand) => void
}) {
  const [drag, setDrag] = useState<number | null>(null) // seek bar, seconds
  const dragging = useRef(0)
  useEffect(() => () => clearTimeout(dragging.current), [])
  const item = useTunnelQuery<Item>(jf.item(st.itemId)).data ?? null
  const pos = st.positionTicks / TICKS_PER_SECOND
  const dur = st.durationTicks / TICKS_PER_SECOND
  const seek = (t: number) => {
    t = clampSeek(t, dur)
    setDrag(t) // until the TV's state catches up
    clearTimeout(dragging.current)
    dragging.current = window.setTimeout(() => setDrag(null), 2000)
    send({ type: 'seek', ticks: Math.floor(t * TICKS_PER_SECOND) })
  }
  const art = item && (backdrop(item) ?? primary(item))
  return (
    <>
      {/* always the box, empty until the art is known: the keys never jump */}
      <Artwork
        art={art}
        width={780}
        // no backdrop: the poster whole, not a band of it
        className={`art remote-art${item && !backdrop(item) ? ' whole' : ''}`}
      />
      <h3>{item?.Name}</h3>
      <input
        type="range"
        aria-label="Position"
        min={0}
        max={Math.max(dur, 1)}
        step={1}
        value={drag ?? pos}
        onChange={(e) => seek(Number(e.target.value))}
        className="seek"
      />
      <small className="remote-time">
        {clock(drag ?? pos)} / {clock(dur)}
      </small>
      <div className="remote-keys">
        <button type="button" onClick={() => seek((drag ?? pos) - 10)}>
          −10 s
        </button>
        <button
          type="button"
          className="primary"
          aria-label={st.paused ? 'Play' : 'Pause'}
          onClick={() => send({ type: st.paused ? 'resume' : 'pause' })}
        >
          <Icon d={st.paused ? ICON.play : ICON.pause} />
        </button>
        <button type="button" onClick={() => seek((drag ?? pos) + 10)}>
          +10 s
        </button>
      </div>
      <button
        type="button"
        className="secondary"
        onClick={() => send({ type: 'stop' })}
      >
        <Icon d={ICON.stop} />
        Stop
      </button>
      <Tracks streams={item?.MediaStreams} st={st} send={send} />
    </>
  )
}

// The remote's audio and subtitle pickers, each only when there is a choice.
function Tracks({
  streams,
  st,
  send,
}: {
  streams: Item['MediaStreams']
  st: ScreenState
  send: (c: ScreenCommand) => void
}) {
  const audio = audioTracks(streams)
  const subs = subtitleTracks(streams)
  return (
    <>
      {audio.length > 1 && (
        <label>
          Audio
          <select
            value={String(st.audio ?? '')}
            onChange={(e) =>
              send({ type: 'tracks', audio: Number(e.target.value) })
            }
          >
            {st.audio == null && <option value="">Default</option>}
            {audio.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {subs.length > 1 && (
        <label>
          Subtitles
          <select
            value={String(st.subtitle ?? -1)}
            onChange={(e) =>
              send({ type: 'tracks', subtitle: Number(e.target.value) })
            }
          >
            {subs.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  )
}
