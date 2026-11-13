// Tunnel framing (docs/protocol.md): one data channel per request. The request
// is one text frame, the response head one text frame, the body binary frames,
// then an `{"eof":true}` text frame, after which the browser closes the channel.
// Not the gateway: old Chromium (webOS TVs) loses frames on a remote close (#72).
import { request } from './diag'
import { AppError, httpError } from './errors'

export type TunnelResponse = {
  status: number
  headers: Record<string, string>
  body: Uint8Array<ArrayBuffer>
}

export function tunnelFetch(
  pc: RTCPeerConnection,
  url: string,
  opts: {
    method?: string
    headers?: Record<string, string>
    body?: string
  } = {},
) {
  const d = request(url)
  return new Promise<TunnelResponse>((resolve, reject) => {
    let dc: RTCDataChannel
    try {
      dc = pc.createDataChannel(`req:${url.slice(0, 200)}`)
    } catch (e) {
      const msg = `createDataChannel: ${e instanceof Error ? e.message : e}`
      d.done(msg)
      throw new AppError('tunnel-lost', msg)
    }
    dc.binaryType = 'arraybuffer'
    let head: { status: number; headers?: Record<string, string> } | null = null
    const chunks: Uint8Array[] = []
    let size = 0
    dc.onerror = (e) =>
      d.done(`channel error: ${(e as RTCErrorEvent).error?.message ?? '?'}`)
    dc.onopen = () => {
      d.opened()
      dc.send(
        JSON.stringify({
          method: opts.method ?? 'GET',
          url,
          headers: opts.headers ?? {},
          ...(opts.body !== undefined && { body: opts.body }),
        }),
      )
    }
    dc.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        chunks.push(new Uint8Array(e.data))
        size += e.data.byteLength
        return
      }
      const m = JSON.parse(e.data)
      if (!m.eof) return void (head = m)
      dc.onclose = null
      dc.close()
      if (!head) {
        d.done('EOF without response head')
        return reject(
          new AppError('tunnel-lost', `tunnel: no response head for ${url}`),
        )
      }
      d.done(`HTTP ${head.status}`)
      const body = new Uint8Array(size)
      let off = 0
      for (const c of chunks) {
        body.set(c, off)
        off += c.length
      }
      resolve({ status: head.status, headers: head.headers ?? {}, body })
    }
    dc.onclose = () => {
      d.done(head ? 'closed before EOF' : 'closed before response')
      reject(
        new AppError(
          'tunnel-lost',
          `tunnel: ${head ? 'truncated response' : 'no response'} for ${url}`,
        ),
      )
    }
  })
}

/** JSON over the tunnel: GET, or POST when body is given. Throws on non-2xx. */
export async function tunnelJson<T>(
  pc: RTCPeerConnection,
  url: string,
  body?: unknown,
): Promise<T> {
  const r = await tunnelFetch(
    pc,
    url,
    body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) },
  )
  if (r.status < 200 || r.status > 299)
    throw httpError('tunnel', r.status, url.split('?')[0])
  const text = new TextDecoder().decode(r.body)
  return (text ? JSON.parse(text) : null) as T
}

/**
 * A held response read line by line (GET /streamiq/screen, NDJSON). onLine per
 * line; onEnd once when it ends without us closing it (refused, or the channel
 * or session closed). Returns close(): closing the channel ends it on the
 * gateway too. A session that's gone ends it at once.
 */
export function tunnelLines(
  pc: RTCPeerConnection,
  url: string,
  onLine: (line: string) => void,
  onEnd: (why: string) => void,
) {
  let dc: RTCDataChannel
  try {
    dc = pc.createDataChannel(`req:${url}`)
  } catch (e) {
    queueMicrotask(() =>
      onEnd(`createDataChannel: ${e instanceof Error ? e.message : e}`),
    )
    return () => {}
  }
  dc.binaryType = 'arraybuffer'
  const text = new TextDecoder()
  let buf = ''
  const close = () => {
    dc.onclose = null
    dc.onmessage = null
    dc.close()
  }
  const end = (why: string) => {
    close()
    onEnd(why)
  }
  dc.onopen = () => dc.send(JSON.stringify({ method: 'GET', url, headers: {} }))
  dc.onmessage = (e) => {
    if (typeof e.data === 'string') {
      const m = JSON.parse(e.data)
      if (m.eof) end('ended by the gateway')
      else if (m.status !== 200) end(`HTTP ${m.status}`)
      return
    }
    buf += text.decode(e.data, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()!
    for (const l of lines) if (l) onLine(l)
  }
  dc.onclose = () => end('connection closed')
  return close
}
