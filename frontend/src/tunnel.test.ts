import { test } from 'node:test'
import assert from 'node:assert/strict'

// diag.ts (imported by tunnel.ts) hooks window errors at load.
;(globalThis as any).addEventListener ??= () => {}
const { tunnelFetch } = await import('./tunnel.ts')
const { diag } = await import('./diag.ts')

// A fake data channel: records what the browser sends and whether it closed.
function channel() {
  const dc: any = {
    sent: [] as string[],
    closed: false,
    send: (m: string) => dc.sent.push(m),
    close: () => (dc.closed = true),
  }
  const pc = { createDataChannel: () => dc } as unknown as RTCPeerConnection
  return { dc, pc }
}
const play = (dc: any, frames: (string | number)[]) => {
  for (const f of frames)
    dc.onmessage({
      data: typeof f === 'string' ? f : new Uint8Array(f).fill(f).buffer,
    })
}
// The diagnostics row of the last request.
const lastReq = () => diag.reqs[diag.reqs.length - 1]

// Plays the gateway's frames into tunnelFetch over a fake data channel.
function fetchWith(frames: (string | number)[]) {
  const { dc, pc } = channel()
  const p = tunnelFetch(pc, '/x.ts')
  dc.onopen()
  play(dc, frames)
  return p
}
const head = (len: number) =>
  JSON.stringify({
    status: 200,
    headers: { 'Content-Type': 'video/mp2t', 'Content-Length': String(len) },
  })

test('full body resolves', async () => {
  const r = await fetchWith([head(5), 3, 2, '{"eof":true}'])
  assert.deepEqual([...r.body], [3, 3, 3, 2, 2]) // the chunks, in order
})

test('fewer bytes than Content-Length at eof fails (#263)', async () => {
  await assert.rejects(fetchWith([head(5), 3, '{"eof":true}']), /3 of 5 bytes/)
})

test('error frame fails (#263)', async () => {
  await assert.rejects(
    fetchWith([head(5), 3, '{"error":"read body: unexpected EOF"}']),
    /unexpected EOF/,
  )
})

test('the request frame goes out on open; the browser closes after eof', async () => {
  const { dc, pc } = channel()
  const p = tunnelFetch(pc, '/streamiq/name', {
    method: 'POST',
    headers: { 'X-A': '1' },
    body: '{"name":"n"}',
  })
  assert.deepEqual(dc.sent, []) // nothing before the channel opens
  assert.equal(lastReq().opened, false)
  dc.onopen()
  assert.equal(lastReq().opened, true)
  assert.deepEqual(JSON.parse(dc.sent[0]), {
    method: 'POST',
    url: '/streamiq/name',
    headers: { 'X-A': '1' },
    body: '{"name":"n"}',
  })
  play(dc, [JSON.stringify({ status: 204 }), '{"eof":true}'])
  const r = await p
  assert.deepEqual([r.status, r.headers, r.body.byteLength], [204, {}, 0])
  assert.equal(dc.closed, true)
  assert.equal(dc.onclose, null) // our own close is no failure
  assert.equal(lastReq().result, 'HTTP 204')
  // A GET carries no body field.
  const g = channel()
  void tunnelFetch(g.pc, '/x').catch(() => {})
  g.dc.onopen()
  assert.deepEqual(JSON.parse(g.dc.sent[0]), {
    method: 'GET',
    url: '/x',
    headers: {},
  })
})

test('the channel closing first fails the request', async () => {
  const before = channel()
  const p1 = tunnelFetch(before.pc, '/a')
  before.dc.onopen()
  before.dc.onclose()
  await assert.rejects(p1, /no response for \/a/)
  assert.equal(lastReq().result, 'closed before response')
  const mid = channel()
  const p2 = tunnelFetch(mid.pc, '/b')
  mid.dc.onopen()
  play(mid.dc, [head(5), 3])
  mid.dc.onclose()
  await assert.rejects(p2, /truncated response for \/b/)
  assert.equal(lastReq().result, 'closed before EOF')
})

test('eof without a head fails; a channel error is logged', async () => {
  await assert.rejects(fetchWith(['{"eof":true}']), /no response head/)
  assert.equal(lastReq().result, 'EOF without response head')
  const { dc, pc } = channel()
  const p = tunnelFetch(pc, '/c')
  dc.onerror({ error: { message: 'sctp abort' } })
  assert.equal(lastReq().result, 'channel error: sctp abort')
  dc.onclose()
  await assert.rejects(p, /no response/)
})
