// Run: node --test src/features/player/timing.test.ts (part of scripts/check.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closable, startAudio } from './timing.ts'

test('startAudio: a pick while starting carries the source id (#615)', () => {
  assert.deepEqual(startAudio(2, undefined, 'ms1'), { track: 2, source: 'ms1' })
})

test('startAudio: autoAudio’s track, else Jellyfin’s default', () => {
  assert.deepEqual(startAudio(undefined, 3, 'ms1'), { track: 3, source: 'ms1' })
  assert.deepEqual(startAudio(undefined, undefined, 'ms1'), {})
})

test('closable: nothing gets through after close (#615)', () => {
  const got: string[] = []
  const c = closable((p: string) => got.push(p))
  c.set('before')
  c.close()
  c.set('late error')
  assert.deepEqual(got, ['before'])
})
