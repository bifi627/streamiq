// A page's hold on its gateway's shared session that outlives a network
// change: a phone moving between Wi-Fi and cellular gets a new address,
// and with no ICE restart the old tunnel can't recover. A dropped session is
// released and a fresh one shared; its users get the new pc (the player
// reloads at its playhead). Only stub-able imports, so node:test drives it.
import { noop } from '../../shared/noop.ts'

/** A disconnected that recovers within this keeps the tunnel. */
export const GRACE_MS = 5_000
/** How long after a drop new tunnels are tried before the error. */
export const RETRY_MS = 60_000
const POLL_MS = 1_000 // pc.close() fires no connectionstatechange: poll
const PAUSE_MS = 2_000 // between reconnect attempts

type Held = { pc: { connectionState: string }; closed: boolean }
type Share<S> = (id: string) => { session: Promise<S>; release: () => void }

/** Dropped: failed or closed at once, disconnected since `since` for
 * GRACE_MS. */
export function dropped(s: Held, since: number | undefined, now: number) {
  const st = s.pc.connectionState
  if (s.closed || st === 'failed' || st === 'closed') return true
  return st === 'disconnected' && since !== undefined && now - since >= GRACE_MS
}

/** Another attempt after a failed connect: only after a drop, within
 * RETRY_MS of it. The first connect's failure is the error at once. */
export const retries = (dropAt: number | undefined, now: number) =>
  dropAt !== undefined && now - dropAt < RETRY_MS

/** Holds the gateway's session until the returned release: `up` gets each
 * session (a new one after a drop), `error` a connect that won't come. */
export function hold<S extends Held>(
  gatewayId: string,
  share: Share<S>,
  on: { up: (s: S) => void; error: (e: unknown) => void; dropped: () => void },
  { now = Date.now, poll = POLL_MS, pause = PAUSE_MS } = {},
) {
  let gone = false
  let release = noop
  let timer: ReturnType<typeof setTimeout> | undefined
  let dropAt: number | undefined

  const watch = (s: S) => {
    let since: number | undefined
    timer = setInterval(() => {
      since =
        s.pc.connectionState === 'disconnected' ? (since ?? now()) : undefined
      if (!dropped(s, since, now())) return
      clearInterval(timer)
      dropAt = now()
      on.dropped()
      release()
      open()
    }, poll)
  }
  const open = () => {
    const h = share(gatewayId)
    release = h.release
    h.session.then(
      (s) => {
        if (gone) return
        dropAt = undefined
        on.up(s)
        watch(s)
      },
      (e) => {
        if (gone) return
        release()
        if (!retries(dropAt, now())) return on.error(e)
        timer = setTimeout(open, pause)
      },
    )
  }
  open()
  return () => {
    gone = true
    clearInterval(timer)
    release()
  }
}
