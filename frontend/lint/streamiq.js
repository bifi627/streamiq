// Our CLAUDE.md conventions that no existing rule covers, as oxlint rules (jsPlugins;
// e2e also loads eslint-plugin-playwright, @ts-* is oxlint's typescript/ban-ts-comment).
// oxlint's JS plugin API is alpha and not semver: an oxlint bump can break this file;
// lint/streamiq.test.js catches it. require-suppression-reason and no-test-timeout are
// adapted from t3code's oxlint-plugin-t3code (MIT, see LICENSE-t3code).

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i
// group 1: what follows ` -- `, the reason
const DISABLE =
  /^[\s*]*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?![\w-])[^]*?(?:\s--([^]*))?$/
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
          const m = DISABLE.exec(c.value)
          if (!m || m[1]?.trim() || explainedAbove(c)) continue
          context.report({
            loc: c.loc,
            message:
              'Say why: end the directive with `-- <reason>` or put a comment on the line above.',
          })
        }
      },
    }
  },
}

// Walks `test.describe.configure` / `test.info().setTimeout` down to its root identifier.
const chainRoot = (n) =>
  n?.type === 'Identifier'
    ? n.name
    : n?.type === 'MemberExpression'
      ? chainRoot(n.object)
      : n?.type === 'CallExpression'
        ? chainRoot(n.callee)
        : undefined

// test.slow() is playwright/no-slowed-test
const noTestTimeout = {
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
    'require-suppression-reason': requireSuppressionReason,
    'no-test-timeout': noTestTimeout,
    'no-literal-email': noLiteralEmail,
    'no-hardcoded-locale': noHardcodedLocale,
  },
}
