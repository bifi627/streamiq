// One tunnel session per gateway, shared by the routes that need it (#152): the
// library and the web gateway page's details. Counted users; the session closes
// IDLE_MS after the last release, and a new user in that window keeps it. A
// failed connect, a dropped or closed session, or a changed ICE policy (relay toggle) is
// evicted lazily: the next user opens a fresh one. No imports, so node:test can
// drive it with a stubbed `open`; connect.ts wires it to the real connect().

export const IDLE_MS = 30_000

type Closable = {
  pc: { connectionState: string }
  close: () => void
  closed?: boolean
}
type Entry<S> = {
  p: Promise<S>
  s?: S
  users: number
  policy: unknown
  timer?: ReturnType<typeof setTimeout>
}

export function sharer<S extends Closable>(
  open: (gatewayId: string) => Promise<S>,
  policy: () => unknown = () => null,
  idleMs = IDLE_MS,
) {
  const map = new Map<string, Entry<S>>()
  const shut = (e: Entry<S>) =>
    void e.p.then(
      (s) => s.close(),
      () => {},
    )
  const evict = (id: string, e: Entry<S>) => {
    if (map.get(id) !== e) return
    map.delete(id)
    clearTimeout(e.timer)
    if (e.users === 0) shut(e) // users still holding it close it on release
  }

  /** Drop the gateway's shared session for the next user (re-paired: new cert). */
  const drop = (gatewayId: string) => {
    const e = map.get(gatewayId)
    if (e) evict(gatewayId, e)
  }

  /** The gateway's shared session; call release() once when done with it. */
  function share(gatewayId: string) {
    let e = map.get(gatewayId)
    // disconnected too: its current users keep it (it may recover), new ones
    // don't. closed: the session closed itself, e.g. when the broker closed it
    // because the gateway's socket dropped (#172), before its pc says so.
    const dead =
      !!e?.s?.closed ||
      ['disconnected', 'failed', 'closed'].includes(
        e?.s?.pc.connectionState ?? '',
      )
    if (e && (dead || e.policy !== policy())) evict(gatewayId, e)
    e = map.get(gatewayId)
    if (!e) {
      const n: Entry<S> = { p: open(gatewayId), users: 0, policy: policy() }
      // A failed connect is never cached: each current user sees the error.
      n.p.then(
        (s) => (n.s = s),
        () => evict(gatewayId, n),
      )
      map.set(gatewayId, (e = n))
    }
    const entry = e
    clearTimeout(entry.timer)
    entry.users++
    let released = false
    return {
      session: entry.p,
      release() {
        if (released) return
        released = true
        if (--entry.users > 0) return
        if (map.get(gatewayId) !== entry) return shut(entry)
        entry.timer = setTimeout(() => evict(gatewayId, entry), idleMs)
      },
    }
  }
  return { share, drop }
}
