import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guessTv } from './tv.ts'

const cases: [string, string, number, string][] = [
  [
    'webOS TV (LG, Chrome 87 engine)',
    'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36 WebAppManager',
    0,
    'tv',
  ],
  [
    'Samsung Tizen',
    'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.0 TV Safari/537.36',
    0,
    'tv',
  ],
  [
    'Android TV',
    'Mozilla/5.0 (Linux; Android 12; BRAVIA 4K VH2 Build/STT1.211025.001.Z4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Safari/537.36',
    0,
    'unsure',
  ],
  [
    'Android phone',
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    5,
    'other',
  ],
  [
    'Android tablet',
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    10,
    'other',
  ],
  [
    'desktop Chrome',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    0,
    'other',
  ],
  [
    'headless Chrome',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36',
    0,
    'other',
  ],
]

for (const [name, ua, touch, want] of cases)
  test(`guessTv: ${name}`, () => assert.equal(guessTv(ua, touch), want))
