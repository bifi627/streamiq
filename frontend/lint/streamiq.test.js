import { describe, it } from 'node:test'
import { RuleTester } from 'oxlint/plugins-dev'
import plugin from './streamiq.js'

RuleTester.describe = describe
RuleTester.it = it
const tester = new RuleTester()
const run = (name, tests) => tester.run(name, plugin.rules[name], tests)

run('require-suppression-reason', {
  valid: [
    '// oxlint-disable-next-line complexity -- render branching\nf()',
    '// render branching\n// oxlint-disable-next-line complexity\nf()',
  ],
  invalid: [
    { code: '// oxlint-disable-next-line complexity\nf()', errors: 1 },
    { code: '/* eslint-disable */\nf()', errors: 1 },
    { code: 'g()\n// oxlint-disable-next-line complexity --\nf()', errors: 1 },
  ],
})

run('no-test-timeout', {
  valid: ["test('plays @player', f)", 'page.setTimeout(5)'],
  invalid: [
    { code: 'test.setTimeout(300_000)', errors: 1 },
    { code: 'test.info().setTimeout(5)', errors: 1 },
    { code: 'test.describe.configure({ retries: 2 })', errors: 1 },
  ],
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

run('no-low-value-comments', {
  valid: [
    '// the buffer outlives a seek\nconst playerState = 1',
    '// range 1 -- 3, not a divider\nf()',
    '// TODO(#12): split it\n// quirk(#34): webOS drops it\nf()',
    '// oxlint-disable-next-line complexity -- see #12\nf()',
    '// uses `#12` as the example\nf()',
    '// act on the reply\nf()',
    '// observe() warns on an unknown type (unsupported: none)\nf()',
    '// null = none, late = past the wait\nf()',
    'f()\n// 1\n// 2\n// 3\n// 4\n// 5\n// 6\nf()',
    '// a\n// b\n// c\n// d\n// e\n// f\n// g\nimport x from "y"',
  ],
  invalid: [
    { code: '// player state\nconst playerState = 1', errors: 1 },
    { code: '// ------------\nf()', errors: 1 },
    { code: '// ===== Helpers =====\nf()', errors: 1 },
    { code: '// const x = load(y);\nf()', errors: 1 },
    { code: '// const x = load(y)\nf()', errors: 1 },
    { code: '// await page.reload()\nf()', errors: 1 },
    { code: 'f()\n// arrange\nf()', errors: 1 },
    { code: '// Given:\nf()', errors: 1 },
    { code: '// keeps the order (#330)\nf()', errors: 1 },
    { code: 'f()\n// 1\n// 2\n// 3\n// 4\n// 5\n// 6\n// 7\nf()', errors: 1 },
  ],
})
