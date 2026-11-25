import { test } from 'node:test'
import assert from 'node:assert/strict'
import { look } from './routeLook.ts'

test('look: a relay the networks needed keeps its label and why', () => {
  const l = look('relay', ' · 1.0 MB relayed')
  assert.equal(l.label, 'Relayed · encrypted')
  assert.match(
    l.explain,
    /^Your networks couldn't connect directly, .* · 1\.0 MB relayed$/,
  )
})

test('look: a forced relay names the setting and where it is turned off', () => {
  const l = look('forced', ' · 2.0 MB relayed')
  assert.equal(l.label, 'Relayed · forced')
  assert.equal(
    l.explain,
    "This connection was opened with Force relay on in this browser, so the stream passes an encrypted relay that can't see it · 2.0 MB relayed · turn it off in Diagnostics → Force relay (TURN), or drop ?relay from the address",
  )
  assert.doesNotMatch(l.explain, /couldn't connect/)
})

test('look: the TLS-only variant says so, same label and icon', () => {
  const tls = look('forcedTls', '')
  assert.equal(tls.label, 'Relayed · forced')
  assert.equal(tls.icon, look('forced', '').icon)
  assert.match(
    tls.explain,
    /^This connection was opened with Force relay over TLS \(443\) on/,
  )
})

test('look: every route has its own icon', () => {
  const icons = (['lan', 'direct', 'relay', 'forced'] as const).map(
    (r) => look(r, '').icon,
  )
  assert.equal(new Set(icons).size, icons.length)
})
