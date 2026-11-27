// Run: node --test src/features/screen/jumpscares.test.ts (part of scripts/check.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  importJumpScares,
  jumpScareHint,
  loadJumpScares,
  parseJumpScares,
  saveJumpScares,
} from './jumpscares.ts'

// whenjumpscare.com's file for The Shining, CRLF like a Windows download.
const SHINING = [
  '1',
  '00:50:03,000 --> 00:50:07,000',
  '⚠️ Minor jumpscare approaching at 00:50:08',
  '',
  '2',
  '02:08:35,000 --> 02:08:39,000',
  '⚠️ MAJOR jumpscare approaching at 02:08:40',
  '',
].join('\r\n')

test('parseJumpScares: the time in the cue text, major or minor', () => {
  assert.deepEqual(parseJumpScares(SHINING), [
    { at: 50 * 60 + 8, major: false },
    { at: 2 * 3600 + 8 * 60 + 40, major: true },
  ])
})

test('parseJumpScares: other cues are ignored; an ordinary subtitle finds none', () => {
  assert.deepEqual(
    parseJumpScares('1\n00:00:01,000 --> 00:00:02,000\nHello at 00:00:05\n'),
    [],
  )
})

test('parseJumpScares: sorted by time', () => {
  const srt =
    'Major jumpscare approaching at 00:10:00\nMinor jump scare at 00:01:00'
  assert.deepEqual(
    parseJumpScares(srt).map((s) => s.at),
    [60, 600],
  )
})

test('jumpScareHint: the next scare after the position, then none', () => {
  const list = parseJumpScares(SHINING)
  assert.equal(
    jumpScareHint(list, 50 * 60 + 8 - 42),
    'Next jump scare in 0:42 (minor)',
  )
  assert.match(jumpScareHint(list, 50 * 60 + 8), /\(major\)$/)
  assert.equal(jumpScareHint(list, 3 * 3600), 'No more jump scares')
})

function memory() {
  const m = new Map<string, string>()
  const s = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  } as Storage
  return () => s
}

test('save/load: per item, a new save replaces the list', () => {
  const s = memory()
  assert.equal(saveJumpScares('a', [{ at: 1, major: false }], s), true)
  assert.equal(saveJumpScares('a', [{ at: 2, major: true }], s), true)
  assert.deepEqual(loadJumpScares('a', s), [{ at: 2, major: true }])
  assert.deepEqual(loadJumpScares('b', s), [])
})

test('save/load: no storage or a throwing one is no list, no crash', () => {
  const blocked = (): Storage => {
    throw new Error('SecurityError')
  }
  const full = () =>
    ({
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }) as unknown as Storage
  assert.deepEqual(loadJumpScares('a', blocked), [])
  assert.equal(saveJumpScares('a', [], blocked), false)
  assert.equal(saveJumpScares('a', [], full), false)
  assert.deepEqual(
    loadJumpScares('a', () => undefined),
    [],
  )
  assert.equal(
    saveJumpScares('a', [], () => undefined),
    false,
  )
})

test('load: a corrupt entry is no list', () => {
  const s = memory()
  s().setItem('streamiq:jumpscares:a', '{nope')
  assert.deepEqual(loadJumpScares('a', s), [])
})

test('importJumpScares: no match stores nothing, the old list stays', () => {
  const s = memory()
  saveJumpScares('a', [{ at: 1, major: true }], s)
  assert.deepEqual(importJumpScares('a', 'hello', s), {
    msg: 'No jump scares found in this file',
  })
  assert.deepEqual(loadJumpScares('a', s), [{ at: 1, major: true }])
})

test('importJumpScares: a match is stored and shown, no message', () => {
  const s = memory()
  const r = importJumpScares('a', SHINING, s)
  assert.equal(r.msg, '')
  assert.equal(r.list?.length, 2)
  assert.deepEqual(loadJumpScares('a', s), r.list)
})

test('importJumpScares: storage fails: shown anyway, the user is told', () => {
  const r = importJumpScares('a', SHINING, () => undefined)
  assert.equal(r.list?.length, 2)
  assert.equal(r.msg, "Couldn't save on this device")
})
