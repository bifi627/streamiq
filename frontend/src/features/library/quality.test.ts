// Run: node --test src/features/library/quality.test.ts (part of scripts/check.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { qualityOptions } from './quality.ts'

const fourK = { size: { width: 3840, height: 2160 }, bitrate: 40e6 }
const opt = (o: ReturnType<typeof qualityOptions>, v: string) =>
  o.find((x) => x.value === v)!

test('Auto names data saver, the link and its pick', () => {
  const o = qualityOptions(
    fourK,
    'Auto',
    { mbps: 12.34, auto: '720p', saver: true },
    false,
    false,
  )
  assert.equal(
    opt(o, 'Auto').label,
    `Auto · 720p (data saver, your connection ~${(12).toLocaleString()} Mbps)`,
  )
  assert.equal(opt(o, 'Auto').hint, 'no limit')
})

test('Auto without a measurement or data saver is plain', () => {
  const o = qualityOptions(fourK, 'Auto', { auto: 'Auto' }, false, false)
  assert.equal(opt(o, 'Auto').label, 'Auto')
  const fits = qualityOptions(
    fourK,
    'Auto',
    { mbps: 100, auto: 'Auto' },
    false,
    false,
  )
  assert.equal(
    opt(fits, 'Auto').label,
    `Auto (your connection ~${(100).toLocaleString()} Mbps)`,
  )
})

test('Source warns when it is faster than the link', () => {
  const slow = qualityOptions(
    fourK,
    'Auto',
    { mbps: 10, auto: '1080p' },
    false,
    false,
  )
  assert.match(
    opt(slow, 'Source').hint,
    /^4K, .* · faster than your connection, may stutter$/,
  )
  const fast = qualityOptions(
    fourK,
    'Auto',
    { mbps: 100, auto: 'Auto' },
    false,
    false,
  )
  assert.doesNotMatch(opt(fast, 'Source').hint, /stutter/)
  const unknown = qualityOptions(
    { size: { width: 0, height: 0 } },
    'Auto',
    { auto: 'Auto' },
    false,
    false,
  )
  assert.equal(opt(unknown, 'Source').hint, 'no limit')
})

test('rungs show their bitrate; Raw only with its setting', () => {
  const o = qualityOptions(fourK, 'Auto', { auto: 'Auto' }, false, false)
  assert.equal(opt(o, '720p').hint, `${(4).toLocaleString()} Mbps`)
  assert.equal(opt(o, 'Raw'), undefined)
  const raw = qualityOptions(fourK, 'Auto', { auto: 'Auto' }, true, false)
  assert.equal(opt(raw, 'Raw').hint, 'original streams, unchecked')
})

test('compatible mode disables Source and Raw only', () => {
  const o = qualityOptions(fourK, 'Auto', { auto: 'Auto' }, true, true)
  for (const v of ['Source', 'Raw']) {
    assert.equal(opt(o, v).disabled, true)
    assert.equal(
      opt(o, v).hint,
      'Off in compatible mode — turn it off in Settings',
    )
  }
  assert.equal(opt(o, '1080p').disabled, undefined)
})
