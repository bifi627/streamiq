// Our CLAUDE.md conventions as oxlint rules (jsPlugins). oxlint's JS plugin API is alpha
// and not semver: an oxlint bump can break this file; lint/streamiq.test.js catches it.
// require-suppression-reason and no-test-timeout-or-unreasoned-skip are adapted from
// t3code's oxlint-plugin-t3code (MIT, see LICENSE-t3code).
import { readFileSync } from 'node:fs'
import path from 'node:path'

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i
// group 1: what follows the directive, where the reason goes
const DISABLE =
  /^[\s*]*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?![\w-])[^]*?(?:\s--([^]*))?$/
const TS_DIRECTIVE =
  /^[\s*]*@ts-(?:expect-error|ignore|nocheck)(?![\w-])([^]*)$/
const isDirective = (text) =>
  /^[\s*]*(?:(?:oxlint|eslint)-(?:disable|enable)|@ts-)/.test(text)

const requireSuppressionReason = {
  meta: { type: 'problem' },
  create(context) {
    const { sourceCode } = context
    return {
      Program() {
        const comments = sourceCode.getAllComments()
        const ownLineByEndLine = new Map()
        for (const c of comments) {
          const { line, column } = c.loc.start
          if (!sourceCode.lines[line - 1].slice(0, column).trim())
            ownLineByEndLine.set(c.loc.end.line, c)
        }
        // a plain comment on the line(s) above, skipping stacked directives
        const explainedAbove = (c) => {
          let above = ownLineByEndLine.get(c.loc.start.line - 1)
          while (
            above &&
            (isDirective(above.value) || !above.value.replace(/[\s*]/g, ''))
          )
            above = ownLineByEndLine.get(above.loc.start.line - 1)
          return above !== undefined
        }
        for (const c of comments) {
          const m = DISABLE.exec(c.value) ?? TS_DIRECTIVE.exec(c.value)
          if (!m || m[1]?.replace(/^[\s:-]+/, '').trim() || explainedAbove(c))
            continue
          context.report({
            loc: c.loc,
            message:
              'Say why: end the directive with `-- <reason>` (@ts-*: any text after it) or put a comment on the line above.',
          })
        }
      },
    }
  },
}

let tags
// The `(tags: @a @b …)` list in e2e/playwright.config.ts is the one list of area tags.
function areaTags() {
  if (tags) return tags
  const file = path.join(
    import.meta.dirname,
    '..',
    '..',
    'e2e',
    'playwright.config.ts',
  )
  const list = /\(tags:([^)]*)\)/.exec(readFileSync(file, 'utf8'))?.[1]
  tags = list?.match(/@\w+/g)
  if (!tags) throw new Error(`no "(tags: @…)" list in ${file}`)
  return tags
}

const titleText = (arg) =>
  arg?.type === 'Literal'
    ? String(arg.value)
    : arg?.type === 'TemplateLiteral'
      ? arg.quasis.map((q) => q.value.cooked).join('')
      : ''

// `{ tag: '@a' }` or `{ tag: ['@a', '@b'] }`
const detailTags = (arg) => {
  const prop =
    arg?.type === 'ObjectExpression' &&
    arg.properties.find((p) => (p.key?.name ?? p.key?.value) === 'tag')
  if (!prop) return ''
  const v = prop.value
  return (v.type === 'ArrayExpression' ? v.elements : [v])
    .map(titleText)
    .join(' ')
}

const e2eAreaTag = {
  meta: { type: 'problem' },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'test')
          return
        const text = `${titleText(node.arguments[0])} ${detailTags(node.arguments[1])}`
        if (!areaTags().some((t) => new RegExp(`${t}\\b`).test(text)))
          context.report({
            node,
            message: `A test needs an area tag (${areaTags().join(' ')}), in its title or \`tag\`.`,
          })
      },
    }
  },
}

const noWaitForTimeout = {
  meta: { type: 'problem' },
  create(context) {
    return {
      'CallExpression > MemberExpression.callee[property.name="waitForTimeout"]'(
        node,
      ) {
        context.report({
          node,
          message:
            'A fixed sleep flakes under load: wait on state (expect(…).toPass, waitFor…).',
        })
      },
    }
  },
}

const noLiteralEmail = {
  meta: { type: 'problem' },
  create(context) {
    const check = (node, text) => {
      if (typeof text === 'string' && EMAIL.test(text))
        context.report({
          node,
          message:
            'A fixed email shares one account across parallel tests: use uniqueEmail().',
        })
    }
    return {
      Literal: (node) => check(node, node.value),
      TemplateElement: (node) => check(node, node.value.cooked),
    }
  },
}

// Walks `test.describe.skip` / `test.info().setTimeout` down to its root identifier.
const chainRoot = (n) =>
  n?.type === 'Identifier'
    ? n.name
    : n?.type === 'MemberExpression'
      ? chainRoot(n.object)
      : n?.type === 'CallExpression'
        ? chainRoot(n.callee)
        : undefined

const isText = (arg) =>
  (arg?.type === 'Literal' && typeof arg.value === 'string') ||
  arg?.type === 'TemplateLiteral'

const statementOf = (node) => {
  while (node.parent && !/(?:Statement|Declaration)$/.test(node.type))
    node = node.parent
  return node
}

const noTestTimeoutOrUnreasonedSkip = {
  meta: { type: 'problem' },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee
        if (callee.type !== 'MemberExpression' || chainRoot(callee) !== 'test')
          return
        const name = callee.property.name
        const opts = node.arguments[0]
        if (
          name === 'setTimeout' ||
          name === 'slow' ||
          (name === 'configure' &&
            opts?.type === 'ObjectExpression' &&
            opts.properties.some((p) =>
              ['timeout', 'retries'].includes(p.key?.name ?? p.key?.value),
            ))
        )
          context.report({
            node,
            message:
              "A per-test timeout or retry hides a wait that should be event-driven: the config's timeout is the ceiling.",
          })
        // test.skip(cond, 'why') carries its reason; else a comment above the statement
        if (
          ['skip', 'only', 'fixme'].includes(name) &&
          !isText(node.arguments[1]) &&
          !context.sourceCode
            .getCommentsBefore(statementOf(node))
            .some((c) => !isDirective(c.value))
        )
          context.report({
            node,
            message: `test.${name} needs a reason: a description argument, or a comment above (an issue or why it stays).`,
          })
      },
    }
  },
}

const localeArg = (arg) =>
  arg?.type === 'Literal' && typeof arg.value === 'string'
    ? true
    : arg?.type === 'ArrayExpression' && arg.elements.some(localeArg)

const isIntl = (callee) =>
  callee.type === 'MemberExpression' && callee.object.name === 'Intl'

const noHardcodedLocale = {
  meta: { type: 'problem' },
  create(context) {
    const check = (node, isLocaleCall) => {
      if (isLocaleCall && localeArg(node.arguments[0]))
        context.report({
          node,
          message:
            "Pass undefined, not a locale: dates and numbers use the browser's locale.",
        })
    }
    return {
      CallExpression: (node) =>
        check(
          node,
          isIntl(node.callee) ||
            (node.callee.type === 'MemberExpression' &&
              node.callee.property.name?.startsWith('toLocale')),
        ),
      NewExpression: (node) => check(node, isIntl(node.callee)),
    }
  },
}

export default {
  meta: { name: 'streamiq' },
  rules: {
    'require-suppression-reason': requireSuppressionReason,
    'e2e-area-tag': e2eAreaTag,
    'no-wait-for-timeout': noWaitForTimeout,
    'no-test-timeout-or-unreasoned-skip': noTestTimeoutOrUnreasonedSkip,
    'no-literal-email': noLiteralEmail,
    'no-hardcoded-locale': noHardcodedLocale,
  },
}
