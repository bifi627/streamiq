import { test } from 'node:test'
import assert from 'node:assert/strict'

// diag.ts (imported by tunnel.ts) hooks window errors at load.
;(globalThis as any).addEventListener ??= () => {}
const { tunnelFetch } = await import('./tunnel.ts')

// Plays the gateway's frames into tunnelFetch over a fake data channel.
function fetchWith(frames: (string | number)[]) {
  const dc: any = { send() {}, close() {} }
  const pc = { createDataChannel: () => dc } as unknown as RTCPeerConnection
  const p = tunnelFetch(pc, '/x.ts')
  dc.onopen()
  for (const f of frames)
    dc.onmessage({ data: typeof f === 'string' ? f : new ArrayBuffer(f) })
  return p
}
const head = (len: number) =>
  JSON.stringify({ status: 200, headers: { 'Content-Length': String(len) } })

test('full body resolves', async () => {
  const r = await fetchWith([head(5), 3, 2, '{"eof":true}'])
  assert.equal(r.body.byteLength, 5)
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
