import { describe, it } from 'node:test'
import { RuleTester } from 'oxlint/plugins-dev'
import plugin from './streamiq.js'

RuleTester.describe = describe
RuleTester.it = it
const tester = new RuleTester()
const run = (name, tests) => tester.run(name, plugin.rules[name], tests)

run('require-disable-reason', {
  valid: ['// oxlint-disable-next-line complexity -- render branching\nf()'],
  invalid: [
    { code: '// oxlint-disable-next-line complexity\nf()', errors: 1 },
    { code: '/* eslint-disable */\nf()', errors: 1 },
  ],
})

run('e2e-area-tag', {
  valid: [
    "test('plays @player', () => {})",
    "test('plays', { tag: ['@shell', '@player'] }, () => {})",
    "test.skip(cond, 'why')",
  ],
  invalid: [
    { code: "test('plays', () => {})", errors: 1 },
    { code: "test('plays @playerx', () => {})", errors: 1 },
  ],
})

run('no-wait-for-timeout', {
  valid: ['await page.waitForURL(url)'],
  invalid: [{ code: 'await page.waitForTimeout(1000)', errors: 1 }],
})

run('no-literal-email', {
  valid: [
    "const e = uniqueEmail('a')",
    "test('tag @player', f)",
    'const e = `${prefix}-${n}@streamiq.test`',
  ],
  invalid: [
    { code: "signIn('a@b.test')", errors: 1 },
    { code: 'signIn(`me@streamiq.test`)', errors: 1 },
  ],
})

run('no-hardcoded-locale', {
  valid: [
    'd.toLocaleDateString(undefined, { month: "short" })',
    'new Intl.NumberFormat(undefined, o)',
  ],
  invalid: [
    { code: "d.toLocaleTimeString('de-DE')", errors: 1 },
    { code: "new Intl.DateTimeFormat('en-US')", errors: 1 },
    { code: "Intl.NumberFormat(['en-US'])", errors: 1 },
  ],
})
