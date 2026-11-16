import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const mobile = fileURLToPath(new URL('../../..', import.meta.url))
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory()
      ? sources(path)
      : /\.(tsx?|mts)$/.test(path) && !/\.test\./.test(path)
        ? [path]
        : []
  })
}

describe('future mobile error presentation boundary', () => {
  it('reserves native Alert calls for the unified presenter and forbids raw error JSX', () => {
    const violations: string[] = []
    for (const file of [
      ...sources(join(mobile, 'src')),
      ...sources(join(mobile, 'preview')),
      join(mobile, 'App.tsx'),
    ]) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      )
      const visit = (node: ts.Node) => {
        if (
          ts.isImportSpecifier(node) &&
          (node.propertyName ?? node.name).text === 'Alert' &&
          !file.endsWith('/services/errorAlerts.ts')
        )
          violations.push(
            `${relative(mobile, file)}: use showErrorAlert instead of importing Alert`
          )
        if (ts.isJsxExpression(node) && node.expression && ts.isJsxElement(node.parent)) {
          const expression = node.expression
          const name = ts.isIdentifier(expression)
            ? expression.text
            : ts.isPropertyAccessExpression(expression)
              ? expression.name.text
              : ''
          if (/(?:error|errorMessage)$/i.test(name))
            violations.push(`${relative(mobile, file)}: render error through ErrorNotice`)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(violations).toEqual([])
  })
})
