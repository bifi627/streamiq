// Our CLAUDE.md conventions as oxlint rules (jsPlugins). oxlint's JS plugin API is alpha
// and not semver: an oxlint bump can break this file; lint/streamiq.test.js catches it.
import { readFileSync } from 'node:fs'
import path from 'node:path'

const DISABLE = /^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?:\s|$)/
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i

const requireDisableReason = {
  meta: { type: 'problem' },
  create(context) {
    return {
      Program() {
        for (const c of context.sourceCode.getAllComments()) {
          if (DISABLE.test(c.value) && !/\s--\s+\S/.test(c.value))
            context.report({
              node: c,
              message: 'Say why: `oxlint-disable… <rule> -- <reason>`.',
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
    arg.properties.find((p) => p.key?.name === 'tag')
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
    'require-disable-reason': requireDisableReason,
    'e2e-area-tag': e2eAreaTag,
    'no-wait-for-timeout': noWaitForTimeout,
    'no-literal-email': noLiteralEmail,
    'no-hardcoded-locale': noHardcodedLocale,
  },
}
