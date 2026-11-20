// Our CLAUDE.md conventions that no existing rule covers, as oxlint rules (jsPlugins;
// e2e also loads eslint-plugin-playwright, @ts-* is oxlint's typescript/ban-ts-comment).
// oxlint's JS plugin API is alpha and not semver: an oxlint bump can break this file;
// lint/streamiq.test.js catches it. require-suppression-reason, no-test-timeout and
// no-low-value-comments are adapted from t3code's oxlint-plugin-t3code (MIT, see LICENSE-t3code).

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

const COMMENT_DIRECTIVE =
  /^\s*(?:(?:oxlint|eslint)-|@ts-|prettier-ignore|c8 |istanbul )/
const DIVIDER_LINE = /^(?:[-=*#~_/+]{3,}.*|.*[-=*#~_]{3,})$/
const TEST_STEP = /^(?:arrange|act|assert|given|when|then)\s*[:.]?$/i
// `owner/repo#123` names an external tracker; a bare `#123` is our own history.
const ISSUE_REF = /(?<![\w/&#-])#\d+(?![\w-])/
const ALLOWED_REF = /\b(?:TODO|quirk)\(#\d+\)/g
const CODE_SPAN = /`[^`]*`/g
// The file header is the module's overview and may run longer; a why-block in the code may not.
const MAX_COMMENT_LINES = 6
const LICENSE = /^!|@license|\bcopyright\b|\bSPDX-License-Identifier\b/i
const COMMENTED_CODE =
  /^(?:(?:(?:const|let|var)\s+[\w${}[\], ]+=.*|import\s.+\sfrom\s+["'].+["']|(?:await\s+|return\s+)?[\w$.]+\(.*\)|[\w$.[\]]+\s*=\s*.+);|(?:if|for|while|switch)\s*\(.*\)\s*\{|\}(?:\s*else\s*\{)?)$/
const DECLARATION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:static\s+)?(?:readonly\s+)?(?:(?:const|let|var|function\*?|class|interface|type|enum)\s+)?([A-Za-z_$][\w$]*)\s*[?!]?\s*[:=(<{]/
const FILLER = new Set(
  'a an the of for to in on at by with from and or is are be this that it its as get set return create new current value given whether'.split(
    ' ',
  ),
)

const stem = (w) => (w.length > 3 ? w.replace(/([^s])s$/, '$1') : w)
const words = (text) =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => !FILLER.has(w))
    .map(stem)
    .filter((w) => !FILLER.has(w))
const identifierWords = (name) =>
  words(
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2'),
  )
const commentLines = (c) =>
  c.value
    .split('\n')
    .map((l) => l.replace(/^\s*\*?\s?/, '').trim())
    .filter(Boolean)

// Consecutive `//` lines at one indent read as one comment.
const commentGroups = (comments) => {
  const groups = []
  for (const c of comments) {
    const prev = groups.at(-1)?.comments.at(-1)
    if (
      c.type === 'Line' &&
      prev?.type === 'Line' &&
      prev.loc.end.line === c.loc.start.line - 1 &&
      prev.loc.start.column === c.loc.start.column
    ) {
      groups.at(-1).comments.push(c)
      groups.at(-1).lines.push(...commentLines(c))
    } else groups.push({ comments: [c], lines: commentLines(c) })
  }
  return groups
}

const lowValueProblem = (comments, lines, nextLine, isHeader) => {
  const text = comments.map((c) => c.value).join('\n')
  if (!lines.length || comments.some((c) => COMMENT_DIRECTIVE.test(c.value)))
    return undefined
  const isLine = comments[0].type === 'Line'
  if (lines.some((l) => DIVIDER_LINE.test(l)))
    return "Drop the section divider; split the file or let the code's structure show the grouping."
  if (isLine && lines.length === 1 && TEST_STEP.test(lines[0]))
    return 'Drop the test step label.'
  if (ISSUE_REF.test(text.replace(CODE_SPAN, '').replace(ALLOWED_REF, '')))
    return 'Drop the issue number; git history records it. Keep the reason (or use TODO(#N) / quirk(#N): …).'
  if (isLine && lines.every((l) => COMMENTED_CODE.test(l)))
    return 'Delete commented-out code; git keeps the history.'
  const name = DECLARATION.exec(nextLine ?? '')?.[1]
  const content = words(lines.join(' '))
  if (name && content.length && content.length <= 6) {
    const nameWords = new Set(identifierWords(name))
    if (content.every((w) => nameWords.has(w)))
      return 'Drop the comment; it only repeats the name below it. Say why, or say nothing.'
  }
  if (lines.length > MAX_COMMENT_LINES && !isHeader && !LICENSE.test(text))
    return `Cut this to ${MAX_COMMENT_LINES} lines or fewer: keep the constraint, drop the background.`
  return undefined
}

const noLowValueComments = {
  meta: { type: 'suggestion' },
  create(context) {
    const { sourceCode } = context
    return {
      Program(program) {
        const firstLine = program.body[0]?.loc.start.line ?? Infinity
        for (const { comments, lines } of commentGroups(
          sourceCode.getAllComments(),
        )) {
          const last = comments.at(-1)
          const message = lowValueProblem(
            comments,
            lines,
            sourceCode.lines[last.loc.end.line],
            last.loc.end.line < firstLine,
          )
          if (message)
            context.report({
              loc: { start: comments[0].loc.start, end: last.loc.end },
              message,
            })
        }
      },
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
    'no-low-value-comments': noLowValueComments,
  },
}
