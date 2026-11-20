import ts from 'typescript'
import { readFile, readdir } from 'node:fs/promises'
import { relative, resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const EFFECT_CORE_FILES = Object.freeze([
  'packages/collaboration/src/dom-events.ts',
  'wework/src/features/appearance/AppearanceProvider.tsx',
  'wework/src/features/dsh-runtime/DshClientContextProvider.tsx',
])
export const EFFECT_BOUNDARY_MESSAGE =
  'useEffect is restricted to the explicit core files. Remove derived-state effects, use event handlers for user actions, useSyncExternalStore for subscriptions, or move external synchronization into a reviewed domain service. Do not rename the hook, use useLayoutEffect as a workaround, or expand the allowlist to accommodate legacy violations.'

export function effectViolations(source, filename) {
  if (EFFECT_CORE_FILES.includes(filename.replaceAll('\\', '/'))) return []
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const violations = []
  const directCalls = []
  const propertyName = node => {
    if (ts.isComputedPropertyName(node))
      return ts.isStringLiteralLike(node.expression) ? node.expression.text : null
    return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : null
  }
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'useEffect'
    ) {
      const point = file.getLineAndCharacterOfPosition(node.expression.getStart(file))
      directCalls.push({ line: point.line + 1, column: point.character + 1 })
    }
    const imported =
      ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'useEffect'
    const property = ts.isPropertyAccessExpression(node) && node.name.text === 'useEffect'
    const indexed =
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'useEffect'
    const destructured =
      ts.isBindingElement(node) && propertyName(node.propertyName ?? node.name) === 'useEffect'
    const reexported =
      ts.isExportSpecifier(node) && (node.propertyName ?? node.name).text === 'useEffect'
    if (imported || property || indexed || destructured || reexported) {
      const start = node.getStart(file)
      const point = file.getLineAndCharacterOfPosition(start)
      violations.push({ line: point.line + 1, column: point.character + 1 })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return violations.length ? violations : directCalls
}

export const effectBoundaryRule = {
  meta: { type: 'problem', schema: [], messages: { forbidden: EFFECT_BOUNDARY_MESSAGE } },
  create(context) {
    return {
      Program() {
        const filename = relative(root, context.filename)
        for (const { line, column } of effectViolations(context.sourceCode.text, filename))
          context.report({ loc: { line, column: column - 1 }, messageId: 'forbidden' })
      },
    }
  },
}

async function scan(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'target', 'vendor', 'test-results'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await scan(path)))
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path)
  }
  return files
}

export async function checkEffectBoundary() {
  let count = 0
  let fileCount = 0
  for (const directory of ['wework/src', 'wework/wecode', 'wework/dsh', 'packages']) {
    let files
    try {
      files = await scan(join(root, directory))
    } catch (error) {
      if (error.code === 'ENOENT' && directory === 'wework/wecode') continue
      throw error
    }
    for (const path of files) {
      const name = relative(root, path).replaceAll('\\', '/')
      const violations = effectViolations(await readFile(path, 'utf8'), name)
      if (violations.length) fileCount++
      for (const violation of violations)
        console.error(`${name}:${violation.line}:${violation.column} ${EFFECT_BOUNDARY_MESSAGE}`)
      count += violations.length
    }
  }
  console.log(
    `Effect boundary: ${count} violations in ${fileCount} files; ${EFFECT_CORE_FILES.length} explicit core files`
  )
  return count
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkEffectBoundary()
    .then(count => {
      process.exitCode = count ? 1 : 0
    })
    .catch(error => {
      console.error(error.message)
      process.exitCode = 1
    })
}
