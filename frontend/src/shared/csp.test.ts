import assert from 'node:assert/strict'
import { test } from 'node:test'
import { csp } from './csp.ts'

const parse = (p: string) =>
  Object.fromEntries(
    p.split('; ').map((d) => {
      const [k, ...v] = d.split(' ')
      return [k, v]
    }),
  )

test('the production policy: own origin, Firebase, blobs; nothing inline', () => {
  const p = parse(csp({ dev: false, authDomain: 'app.firebaseapp.com' }))
  assert.deepEqual(p['script-src'], ["'self'", 'https://apis.google.com'])
  assert.deepEqual(p['style-src'], ["'self'"])
  assert.deepEqual(p['connect-src'], [
    "'self'",
    'https://identitytoolkit.googleapis.com',
    'https://securetoken.googleapis.com',
    'https://apis.google.com',
  ])
  assert.deepEqual(p['frame-src'], ['https://app.firebaseapp.com'])
  assert.deepEqual(p['media-src'], ["'self'", 'blob:'])
  assert.deepEqual(p['worker-src'], ["'self'", 'blob:'])
  assert.deepEqual(p['img-src'], ["'self'", 'blob:', 'data:'])
  assert.deepEqual(p['object-src'], ["'none'"])
  assert.deepEqual(p['base-uri'], ["'self'"])
  assert.deepEqual(p['frame-ancestors'], ["'none'"])
  assert.ok(!JSON.stringify(p).includes('unsafe'))
})

test('another API origin and the emulator are allowed by origin, socket included', () => {
  const p = parse(
    csp({
      dev: false,
      api: 'http://127.0.0.1:5028/',
      emulator: 'http://127.0.0.1:9099',
      authDomain: 'x.firebaseapp.com',
    }),
  )
  for (const o of [
    'http://127.0.0.1:5028',
    'ws://127.0.0.1:5028',
    'http://127.0.0.1:9099',
  ])
    assert.ok(p['connect-src'].includes(o), o)
  assert.ok(p['frame-src'].includes('http://127.0.0.1:9099'))
  assert.ok(!p['connect-src'].includes('ws:'))
})

test('dev widens only for Vite: inline scripts and styles, the HMR socket', () => {
  const p = parse(csp({ dev: true, authDomain: 'x.firebaseapp.com' }))
  assert.ok(p['script-src'].includes("'unsafe-inline'"))
  assert.ok(p['style-src'].includes("'unsafe-inline'"))
  assert.ok(p['connect-src'].includes('ws:'))
  assert.ok(!p['script-src'].includes("'unsafe-eval'"))
})
