import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultGateway,
  gatewayLabel,
  relayForcedLine,
  report,
  throughputLine,
} from './report.ts'

test('default gateway: first online, else first, else none', () => {
  const g = (id: string, online: boolean) => ({ id, online })
  assert.equal(defaultGateway([g('a', false), g('b', true)]), 'b')
  assert.equal(defaultGateway([g('a', false), g('b', false)]), 'a')
  assert.equal(defaultGateway([]), '')
})

test('gateway label', () => {
  assert.equal(gatewayLabel(undefined), 'none')
  assert.equal(gatewayLabel({ id: 'x', name: 'Home', online: true }), 'Home')
  assert.equal(
    gatewayLabel({ id: 'x', name: null, online: false }),
    'x (offline)',
  )
})

test('throughput line', () => {
  assert.equal(
    throughputLine(10, false),
    'throughput: 10.0 Mbps (median of 3 ~2 s bursts after a warm-up; Auto caps at 7.0 Mbps)',
  )
  assert.match(throughputLine(10, true), /3 × 1 MiB bursts, data saver on/)
})

test('report: optional lines only when set, test block or "not run"', () => {
  const base = {
    browser: 'UA',
    screen: '1x1',
    caps: 'h264',
    cpu: '',
    memory: '',
    lastRun: '',
    test: null,
    gatewayId: 'g1',
  }
  assert.equal(
    report(base),
    'StreamIQ diagnostics\nbrowser: UA\nscreen: 1x1\ncodecs: h264\nconnection test: not run',
  )
  const r = report({
    ...base,
    cpu: 'c',
    memory: 'm',
    lastRun: 'last run …',
    test: { lines: ['paired: no'], failed: 'failed at connect' },
  }).split('\n')
  assert.deepEqual(r.slice(4), [
    'cpu: c',
    'memory: m',
    'last run …',
    'gateway: g1 (?)',
    'paired: no',
    'failed at connect',
  ])
  assert.match(
    report({
      ...base,
      test: { lines: [] },
      gw: { name: 'Home', version: '1.2' },
    }),
    /gateway: Home \(1\.2\)$/,
  )
})

test('relayForcedLine: a gateway with its relay off skips the forced relay', () => {
  assert.equal(relayForcedLine(false, 'yes'), 'relay forced: yes')
  assert.equal(
    relayForcedLine(true, 'yes'),
    'relay forced: skipped (relay off for this gateway)',
  )
})
