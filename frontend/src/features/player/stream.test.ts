// Run: node --test src/features/player/stream.test.ts (part of scripts/check.sh).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoLine, qualityLine, transcodeParams, urlAudio } from './stream.ts'

test('autoLine: link, cap, source, data saver and the pick', () => {
  assert.equal(
    autoLine({
      mbps: 20,
      fresh: 20,
      cap: 14e6,
      bitrate: 40e6,
      saver: false,
      eff: '1080p',
    }),
    'auto: link ~20.0 Mbps → cap 14.0 Mbps, source 40.0 Mbps → 1080p',
  )
  assert.equal(
    autoLine({ mbps: 20, cap: 14e6, saver: false, eff: 'Auto' }),
    'auto: link ~20.0 Mbps (stored hint) → cap 14.0 Mbps, source ? → no limit (fits)',
  )
  assert.equal(
    autoLine({ saver: true, bitrate: 5e6, eff: '480p' }),
    'auto: link unknown, source 5.0 Mbps, data saver on → 480p',
  )
})

test('qualityLine: the rung, Auto’s cap, or no limit', () => {
  assert.equal(
    qualityLine('720p', { height: 720, bitrate: 4e6 }),
    'quality: 720p (≤720p, 4 Mbps)',
  )
  assert.equal(
    qualityLine('Auto', { height: 1080, bitrate: 8e6 }, 3e6),
    'quality: Auto (≤1080p, 3 Mbps)',
  )
  assert.equal(qualityLine('Auto', null, 3e6), 'quality: Auto (≤3 Mbps)')
  assert.equal(qualityLine('Source', null), 'quality: Source (no limit)')
})

test('transcodeParams: Auto ceilings only on an unlimited video transcode', () => {
  const p = new URLSearchParams('VideoBitrate=99')
  transcodeParams(p, false, false)
  assert.equal(p.get('VideoBitrate'), '8000000')
  assert.equal(p.get('MaxHeight'), '1080')
  assert.equal(p.get('MaxWidth'), '1920')
  const capped = new URLSearchParams()
  transcodeParams(capped, false, false, 3e6)
  assert.equal(capped.get('VideoBitrate'), '3000000')
  const high = new URLSearchParams()
  transcodeParams(high, false, false, 50e6)
  assert.equal(high.get('VideoBitrate'), '8000000')
  for (const [copy, limited] of [
    [true, false],
    [false, true],
  ]) {
    const q = new URLSearchParams('VideoBitrate=99')
    transcodeParams(q, copy, limited, 3e6)
    assert.equal(q.toString(), 'VideoBitrate=99')
  }
})

test('urlAudio: the requested stream, else null', () => {
  assert.equal(urlAudio(new URLSearchParams('AudioStreamIndex=2')), 2)
  assert.equal(urlAudio(new URLSearchParams('')), null)
})
