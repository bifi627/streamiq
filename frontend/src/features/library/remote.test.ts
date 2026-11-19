// Run: node --test src/features/library/remote.test.ts (part of scripts/check.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clampSeek, polled } from './remote.ts'

test('clampSeek keeps a seek in 0 … duration', () => {
  assert.equal(clampSeek(-5, 100), 0)
  assert.equal(clampSeek(40, 100), 40)
  assert.equal(clampSeek(120, 100), 100)
})

test('clampSeek has no upper bound while the duration is unknown', () => {
  assert.equal(clampSeek(500, 0), 500)
  assert.equal(clampSeek(-5, 0), 0)
})

const tv = { id: 's1', name: 'TV', state: null }

test('screen found: shown, error cleared, keep polling', () => {
  assert.deepEqual(polled('s1', { screens: [{ ...tv, id: 's0' }, tv] }), {
    screen: tv,
    down: '',
    again: true,
    recovered: false,
  })
})

test('screen gone: closed, stop polling', () => {
  assert.deepEqual(polled('s1', { screens: [] }), {
    screen: null,
    down: '',
    again: false,
    recovered: false,
  })
})

test('error: keep the last screen, show the error, keep polling', () => {
  const p = polled('s1', { error: 'Gateway offline' })
  assert.deepEqual(p, {
    down: 'Gateway offline',
    again: true,
    recovered: false,
  })
  assert.equal('screen' in p, false)
})

test('the first good poll after an error: recovered (#553)', () => {
  assert.equal(
    polled('s1', { screens: [tv] }, 'Gateway offline').recovered,
    true,
  )
  assert.equal(polled('s1', { screens: [tv] }, '').recovered, false)
  assert.equal(polled('s1', { error: 'x' }, 'Gateway offline').recovered, false)
})
