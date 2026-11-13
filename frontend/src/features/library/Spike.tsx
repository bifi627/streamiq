// SPIKE #178 (throwaway, never merged): hold the shared tunnel idle for N
// minutes with one long-lived gateway response open (the future screen
// stream), then start the player from a timer, without a gesture in that moment.
// Everything is logged on the page (persisted across reloads) because the TV has
// no devtools, and the summary goes to the gateway log via /streamiq/spike-log.
import { useContext, useEffect, useReducer } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Tunnel } from './Library'
import { tunnelFetch, tunnelJson } from '../../tunnel'
import { pairInfo } from '../../stats'
import { event } from '../../diag'
import type { Item } from './items'

const LOG = 'streamiq.spike.log'
const read = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(LOG) ?? '[]')
  } catch {
    return []
  }
}
export function spikeLog(m: string) {
  const line = `${new Date().toLocaleTimeString()} ${m}`
  event(`spike ${m}`)
  try {
    localStorage.setItem(LOG, JSON.stringify([...read(), line].slice(-300)))
  } catch {
    /* ignore */
  }
}
/** To the gateway log too (one tunnel request: only at the end, not while idle). */
export function spikeReport(pc: RTCPeerConnection, m: string) {
  spikeLog(m)
  void tunnelFetch(pc, `/streamiq/spike-log?m=${encodeURIComponent(m)}`).catch(
    (e) => spikeLog(`report failed: ${e.message}`),
  )
}
// Module-level: survives a remount (dev StrictMode), unlike a ref's cleanup.
const run: { current: { t0: number; due: number; lines: number; hold: string } | null } = { current: null }
let fired = false
const ua = () => {
  const a = (navigator as { userActivation?: UserActivation }).userActivation
  return a ? `active=${a.isActive} hasBeenActive=${a.hasBeenActive}` : 'n/a'
}

export function SpikePage() {
  const { gatewayId, pc } = useContext(Tunnel)
  const navigate = useNavigate()
  const [, tick] = useReducer((x: number) => x + 1, 0)
  const q = new URLSearchParams(location.search)
  const min = Number(q.get('min') ?? 1)
  const ka = Number(q.get('ka') ?? 0)

  const url = (p: Record<string, string | null>) => {
    const n = new URLSearchParams(location.search)
    for (const [k, v] of Object.entries(p))
      if (v === null) n.delete(k)
      else n.set(k, v)
    return `${location.pathname}?${n}`
  }

  const start = (how: string) => {
    if (run.current) return
    const t0 = Date.now()
    const r = (run.current = { t0, due: t0 + min * 60_000, lines: 0, hold: 'opening' })
    spikeLog(`START ${how} min=${min} ka=${ka} wsping=${q.get('wsping') ?? 0} relay=${q.has('relay')} ${ua()} vis=${document.visibilityState}`)
    const dc = pc.createDataChannel('req:spike-hold')
    dc.binaryType = 'arraybuffer'
    dc.onopen = () =>
      dc.send(JSON.stringify({ method: 'GET', url: `/streamiq/spike-hold?ka=${ka}`, headers: {} }))
    dc.onmessage = (e) => {
      if (typeof e.data === 'string') {
        r.hold = `head ${e.data}`
        spikeLog(`hold ${e.data}`)
      } else r.lines += new Uint8Array(e.data).filter((b) => b === 10).length
      tick()
    }
    dc.onclose = () => {
      r.hold = `CLOSED after ${Math.round((Date.now() - t0) / 1000)}s`
      spikeLog(`hold ${r.hold}`)
      tick()
    }
    ;(window as unknown as { spikeHold: RTCDataChannel }).spikeHold = dc
    tick()
  }

  useEffect(() => {
    spikeLog(`page load ${navigator.userAgent} ${ua()} pc=${pc.connectionState}`)
    const on = (e: Event) => spikeLog(`${e.type} vis=${document.visibilityState}`)
    const names = ['visibilitychange', 'pagehide', 'pageshow', 'freeze', 'resume', 'focus', 'blur', 'online', 'offline']
    names.forEach((n) => (n.startsWith('page') || n === 'focus' || n === 'blur' || n === 'online' || n === 'offline' ? window : document).addEventListener(n, on))
    const pcOn = () => spikeLog(`pc ${pc.connectionState} / ${pc.iceConnectionState}`)
    pc.addEventListener('connectionstatechange', pcOn)
    pc.addEventListener('iceconnectionstatechange', pcOn)
    if (q.has('auto')) start('auto (no click in this document)')

    // Watchdog: a gap means the page was frozen (screen saver, power saving).
    let last = Date.now()
    const t = setInterval(async () => {
      const now = Date.now()
      if (now - last > 15_000) spikeLog(`watchdog: page frozen ${Math.round((now - last) / 1000)}s`)
      last = now
      const r = run.current
      if (r && Math.floor((now - r.t0) / 60_000) !== Math.floor((now - 5000 - r.t0) / 60_000))
        spikeLog(`alive t+${Math.round((now - r.t0) / 60_000)}m pc=${pc.connectionState} hold=${r.hold.slice(0, 20)} nl=${r.lines}`)
      tick()
      if (!r || fired || now < r.due) return
      fired = true
      const p = pairInfo(await pc.getStats())
      const summary = `FIRE after ${Math.round((now - r.t0) / 1000)}s pc=${pc.connectionState} ice=${pc.iceConnectionState} path=${p ? (p.relay ? 'relay' : 'direct') + ` ${p.local}/${p.remote} ${p.protocol}` : 'none'} hold=${r.hold} nl=${r.lines} ${ua()} vis=${document.visibilityState}`
      spikeReport(pc, summary)
      // Probe: does the idle session still carry a request?
      const t1 = Date.now()
      const item =
        q.get('item') ??
        (await tunnelJson<{ Items: Item[] }>(pc, '/Items?Recursive=true&IncludeItemTypes=Movie,Episode&Limit=1&SortBy=SortName')
          .then((x) => x.Items[0]?.Id)
          .catch((e) => spikeLog(`probe FAILED ${e.message}`)))
      if (!item) return spikeLog('no item: stop')
      spikeLog(`probe ok ${Date.now() - t1}ms, play ${item}`)
      ;(window as unknown as { spikeHold?: RTCDataChannel }).spikeHold?.close()
      void navigate({ to: '/g/$gatewayId/play/$itemId', params: { gatewayId, itemId: item }, search: { spike: 1 } as never })
    }, 5000)
    return () => {
      clearInterval(t)
      names.forEach((n) => (n.startsWith('page') || n === 'focus' || n === 'blur' || n === 'online' || n === 'offline' ? window : document).removeEventListener(n, on))
      pc.removeEventListener('connectionstatechange', pcOn)
      pc.removeEventListener('iceconnectionstatechange', pcOn)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pc])

  const r = run.current
  const big = { fontSize: '1.4em', margin: '0.3em', padding: '0.4em 0.8em' }
  const opt = (k: string, vals: string[]) => (
    <p>
      {k}:{' '}
      {vals.map((v) => (
        <a key={v} style={big} href={url({ [k]: v, auto: null })}>
          {(q.get(k) ?? (k === 'min' ? '1' : '0')) === v ? `[${v}]` : v}
        </a>
      ))}
    </p>
  )
  return (
    <section style={{ fontSize: '1.1em' }}>
      <h2>Spike #178: idle session → autoplay</h2>
      {opt('min', ['1', '10', '30', '60'])}
      {opt('ka', ['0', '30'])}
      {opt('wsping', ['0', '25'])}
      <p>
        <button style={big} disabled={!!r} onClick={() => start('click (gesture in this document)')}>
          A: start (click)
        </button>
        <button style={big} disabled={!!r} onClick={() => (location.href = url({ auto: '1' }))}>
          B: reload, start without click
        </button>
        <button style={big} onClick={() => (localStorage.removeItem(LOG), tick())}>
          Clear log
        </button>
      </p>
      <p>
        {r
          ? `running: t+${Math.round((Date.now() - r.t0) / 1000)}s, fires in ${Math.max(0, Math.round((r.due - Date.now()) / 1000))}s · hold: ${r.hold} · keep-alive lines: ${r.lines}`
          : 'not started'}{' '}
        · pc: {pc.connectionState}/{pc.iceConnectionState} · {ua()}
      </p>
      <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.85em' }}>{read().slice(-40).reverse().join('\n')}</pre>
    </section>
  )
}
