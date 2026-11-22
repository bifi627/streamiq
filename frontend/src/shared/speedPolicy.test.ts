import { test } from 'node:test'
import assert from 'node:assert/strict'
import { age, parseReading, plan, switched, toEvery } from './speedPolicy.ts'

const H = 3_600_000

test('plan: a reading younger than the interval is used, older measures', () => {
  const now = 10 * H
  assert.equal(plan('2h', { mbps: 5, at: now - H }, now), 'cache')
  assert.equal(plan('2h', { mbps: 5, at: now - 2 * H }, now), 'measure')
  assert.equal(plan('30m', { mbps: 5, at: now - H }, now), 'measure')
  assert.equal(plan('1d', { mbps: 5, at: now - 20 * H }, now), 'cache')
  assert.equal(plan('2h', undefined, now), 'measure')
  assert.equal(plan('2h', { mbps: 5, at: 0 }, now), 'measure') // legacy value
})

test('plan: Off never measures', () => {
  assert.equal(plan('off', { mbps: 5, at: 0 }, 10 * H), 'cache')
  assert.equal(plan('off', undefined, 10 * H), 'skip')
})

test('switched: only a changed type after a run', () => {
  assert.equal(switched(undefined, 'wifi'), false)
  assert.equal(switched('wifi', 'wifi'), false)
  assert.equal(switched('wifi', 'cellular'), true)
})

test('parseReading: JSON reading, legacy number, junk', () => {
  assert.deepEqual(parseReading('{"mbps":12.5,"at":42}'), {
    mbps: 12.5,
    at: 42,
  })
  assert.deepEqual(parseReading('3.4'), { mbps: 3.4, at: 0 })
  assert.equal(parseReading(null), undefined)
  assert.equal(parseReading('nope'), undefined)
  assert.equal(parseReading('0'), undefined)
  assert.equal(parseReading('{"mbps":"1","at":1}'), undefined)
})

test('toEvery: unknown = 2 h', () => {
  assert.equal(toEvery(null), '2h')
  assert.equal(toEvery('off'), 'off')
  assert.equal(toEvery('5m'), '2h')
})

test('age', () => {
  assert.equal(age(12 * 60_000), '12 min old')
  assert.equal(age(5 * H), '5 h old')
})
