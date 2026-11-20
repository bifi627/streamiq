import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadHints, loadLine, nextAsk } from './host.ts'

const busy =
  'The box is busy: playback may stutter. A GPU or a lower quality helps.'
const lowDisk = 'Low disk space: transcodes may fail.'

test('no host (older gateway) or nothing measured: no line, no hints', () => {
  assert.equal(loadLine(undefined), null)
  assert.equal(loadLine({}), null)
  assert.deepEqual(loadHints(undefined), [])
})

test('the Load line names what was measured', () => {
  const l = loadLine({
    cpu: 42.4,
    memory: { used: 8e9, total: 16e9 },
    disk: { free: 120e9, total: 1e12 },
  })
  assert.match(
    l ?? '',
    /^Load: CPU 42\s?% · memory 8\sGB of 16\sGB · disk 120\sGB free$/,
  )
  assert.match(loadLine({ cpu: 0 }) ?? '', /^Load: CPU 0\s?%$/)
  assert.match(
    loadLine({ memory: { used: 1, total: 2 } }) ?? '',
    /^Load: memory /,
  )
})

test('hints: CPU ≥ 90 %, disk free < 5 GB', () => {
  assert.deepEqual(
    loadHints({ cpu: 89.4, disk: { free: 5e9, total: 1e12 } }),
    [],
  )
  assert.deepEqual(loadHints({ cpu: 90 }), [busy])
  assert.deepEqual(loadHints({ cpu: 89.6 }), [busy]) // shown as 90 %
  assert.deepEqual(loadHints({ disk: { free: 4.9e9, total: 1e12 } }), [lowDisk])
  assert.deepEqual(loadHints({ cpu: 100, disk: { free: 0, total: 1 } }), [
    busy,
    lowDisk,
  ])
})

test('the status is asked again every 10 s, never after a failure', () => {
  assert.equal(nextAsk(true), 10_000)
  assert.equal(nextAsk(false), null)
})
