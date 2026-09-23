import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'

const SOURCE_ROOT = join(process.cwd(), 'src')
const TOOLTIP_COMPONENTS = new Set(['Tooltip', 'TitlebarTooltip'])

describe('icon button tooltip policy', () => {
  test('mounts the global aria-label tooltip capability', () => {
    const appSource = readFileSync(join(SOURCE_ROOT, 'App.tsx'), 'utf8')

    expect(appSource).toContain('<GlobalIconButtonTooltip />')
  })

  test('provides tooltip capability for every statically identifiable icon-only button', () => {
    const violations = sourceFiles(SOURCE_ROOT).flatMap(findIconButtonTooltipViolations)

    expect(violations, formatViolations(violations)).toEqual([])
  })
})

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (extname(entry.name) !== '.tsx' || entry.name.endsWith('.test.tsx')) return []
    return [path]
  })
}

function findIconButtonTooltipViolations(filePath: string): string[] {
  const sourceText = readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const iconNames = lucideIconNames(sourceFile)
  const violations: string[] = []

  const visit = (node: ts.Node) => {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(sourceFile) === 'button' &&
      isIconOnly(node.children, iconNames) &&
      !hasTooltipAncestor(node, sourceFile) &&
      !hasAccessibleTooltipLabel(node.openingElement.attributes)
    ) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      violations.push(`${relative(process.cwd(), filePath)}:${position.line + 1}`)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

function hasAccessibleTooltipLabel(attributes: ts.JsxAttributes): boolean {
  return attributes.properties.some(
    attribute =>
      ts.isJsxAttribute(attribute) &&
      (attribute.name.getText() === 'aria-label' || attribute.name.getText() === 'aria-labelledby')
  )
}

function lucideIconNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>()

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.moduleSpecifier.getText(sourceFile) !== "'lucide-react'" ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue
    }
    for (const element of statement.importClause.namedBindings.elements) {
      names.add(element.name.text)
    }
  }

  return names
}

function isIconOnly(children: ts.NodeArray<ts.JsxChild>, iconNames: Set<string>): boolean {
  const meaningfulChildren = children.filter(
    child => !ts.isJsxText(child) || child.getText().trim() !== ''
  )
  return (
    meaningfulChildren.length > 0 &&
    meaningfulChildren.every(child => isIconExpression(child, iconNames))
  )
}

function isIconExpression(node: ts.Node, iconNames: Set<string>): boolean {
  if (ts.isJsxSelfClosingElement(node)) {
    return isIconTag(node.tagName.getText(), iconNames)
  }
  if (ts.isJsxElement(node)) {
    const tagName = node.openingElement.tagName.getText()
    return (
      isIconTag(tagName, iconNames) ||
      (['span', 'div'].includes(tagName) && isIconOnly(node.children, iconNames))
    )
  }
  if (!ts.isJsxExpression(node) || !node.expression) return false

  const expression = unwrapExpression(node.expression)
  if (ts.isConditionalExpression(expression)) {
    return (
      isIconExpression(expression.whenTrue, iconNames) &&
      isIconExpression(expression.whenFalse, iconNames)
    )
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return isIconExpression(expression.right, iconNames)
  }
  return isIconExpression(expression, iconNames)
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return unwrapExpression(expression.expression)
  }
  return expression
}

function isIconTag(tagName: string, iconNames: Set<string>): boolean {
  return (
    tagName === 'svg' || tagName === 'img' || iconNames.has(tagName) || tagName.endsWith('Icon')
  )
}

function hasTooltipAncestor(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      (ts.isJsxElement(parent) &&
        TOOLTIP_COMPONENTS.has(parent.openingElement.tagName.getText(sourceFile))) ||
      (ts.isJsxSelfClosingElement(parent) &&
        TOOLTIP_COMPONENTS.has(parent.tagName.getText(sourceFile)))
    ) {
      return true
    }
    if (
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isArrowFunction(parent)
    ) {
      return false
    }
  }
  return false
}

function formatViolations(violations: string[]): string {
  if (violations.length === 0) return ''
  return [
    'Icon-only buttons must use Tooltip/TitlebarTooltip or provide aria-label for the global tooltip.',
    ...violations.map(violation => `- ${violation}`),
  ].join('\n')
}
