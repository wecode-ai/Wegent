import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const roles = new Set([
  'button',
  'dialog',
  'alertdialog',
  'menu',
  'menuitem',
  'menuitemradio',
  'menuitemcheckbox',
  'listbox',
  'option',
  'tablist',
  'tab',
  'radiogroup',
  'radio',
  'switch',
  'checkbox',
  'slider',
  'scrollbar',
  'tree',
  'treeitem',
])
const findings = []
const nativeControls = new Set([
  'button',
  'select',
  'textarea',
  'input',
  'details',
  'summary',
  'dialog',
])
let files = 0

function inspect(file) {
  const text = fs.readFileSync(file, 'utf8')
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.js')
      ? ts.ScriptKind.JS
      : file.endsWith('.tsx')
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS
  )
  const sdk = new Set(['DialogSurface'])
  const initializers = new Map()
  function rememberBindings(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const values = initializers.get(node.name.text) ?? []
      values.push(node.initializer)
      initializers.set(node.name.text, values)
    }
    ts.forEachChild(node, rememberBindings)
  }
  rememberBindings(source)
  for (const node of source.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !/^(?:@ui-sdk\/react\/|@wegent\/collaboration\/controls\/(?:DialogSurface|Popover|HoverCard|MenuParts|ScrollArea)$)|(?:^|\/)(?:DialogSurface|controls\/(?:Popover|HoverCard|MenuParts|ScrollArea))$/.test(
        node.moduleSpecifier.text
      )
    )
      continue
    const bindings = node.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings))
      for (const item of bindings.elements) sdk.add(item.name.text)
  }
  function report(node, kind) {
    findings.push({
      file: path.relative(root, file),
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      kind,
    })
  }
  function reportRoles(node, role) {
    if (!role) return
    const roleValues = new Set()
    const examined = new Set()
    function collectRoles(value) {
      if (examined.has(value)) return
      examined.add(value)
      if (ts.isIdentifier(value))
        for (const initializer of initializers.get(value.text) ?? []) collectRoles(initializer)
      if (ts.isStringLiteral(value) && roles.has(value.text)) roleValues.add(value.text)
      ts.forEachChild(value, collectRoles)
    }
    collectRoles(role)
    for (const value of roleValues) report(node, `role:${value}`)
  }
  function suppliedToSdk(node) {
    let parent = node.parent
    while (parent && !ts.isJsxAttribute(parent) && !ts.isJsxElement(parent)) parent = parent.parent
    if (!parent || !ts.isJsxAttribute(parent) || parent.name.getText(source) !== 'render')
      return false
    const owner = parent.parent.parent
    return (
      (ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner)) &&
      sdk.has(owner.tagName.getText(source))
    )
  }
  function bindsName(binding, name) {
    if (ts.isIdentifier(binding)) return binding.text === name
    if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding))
      return binding.elements.some(item => ts.isBindingElement(item) && bindsName(item.name, name))
    return false
  }
  function locallyBound(node, name) {
    for (let scope = node.parent; scope; scope = scope.parent) {
      if (
        ts.isFunctionLike(scope) &&
        scope.parameters.some(parameter => bindsName(parameter.name, name))
      )
        return true
      if (
        ts.isCatchClause(scope) &&
        scope.variableDeclaration &&
        bindsName(scope.variableDeclaration.name, name)
      )
        return true
      if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue
      for (const statement of scope.statements) {
        if (
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(declaration =>
            bindsName(declaration.name, name)
          )
        )
          return true
        if (
          (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          statement.name?.text === name
        )
          return true
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause
          if (clause?.name?.text === name) return true
          const bindings = clause?.namedBindings
          if (
            bindings &&
            (ts.isNamespaceImport(bindings)
              ? bindings.name.text === name
              : bindings.elements.some(item => item.name.text === name))
          )
            return true
        }
      }
    }
    return false
  }
  function visit(node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /^(?:@radix-ui\/|@dnd-kit\/|@mantine\/|@blocknote\/mantine$|react-resizable-panels$)/.test(
        node.moduleSpecifier.text
      )
    ) {
      report(node, `legacy-import:${node.moduleSpecifier.text}`)
    }
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source)
      const [tag, props] = node.arguments
      if (/^(?:React\.)?createElement$/.test(name) && tag && ts.isStringLiteral(tag)) {
        if (nativeControls.has(tag.text)) report(node, `native:${tag.text}`)
        if (props && ts.isObjectLiteralExpression(props)) {
          const role = props.properties.findLast(property => {
            if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
              return false
            return (
              (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
              property.name.text === 'role'
            )
          })
          if (role) reportRoles(node, ts.isPropertyAssignment(role) ? role.initializer : role.name)
        }
      }
      if (
        /^(?:(?:window|globalThis)\.)?(?:confirm|prompt)$/.test(name) &&
        (!ts.isIdentifier(node.expression) || !locallyBound(node, name))
      )
        report(node, `native-dialog:${name}`)
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source)
      const element = ts.isJsxOpeningElement(node) ? node.parent : node
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute)
      const attribute = name => attrs.find(item => item.name.getText(source) === name)
      const string = name => {
        const value = attribute(name)?.initializer
        return value && ts.isStringLiteral(value) ? value.text : undefined
      }
      const browserField =
        tag === 'input' &&
        (string('type') === 'hidden' ||
          (string('type') === 'file' &&
            (attribute('hidden') || string('className')?.split(/\s+/).includes('hidden'))))
      if (!suppliedToSdk(element)) {
        if (nativeControls.has(tag) && !browserField) report(node, `native:${tag}`)
        reportRoles(node, attribute('role')?.initializer)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  files += 1
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (/\.tsx?$/.test(entry.name) && !/\.(?:test|stories|d)\.tsx?$/.test(entry.name))
      inspect(file)
  }
}
for (const area of ['wework/src', 'packages/collaboration/src']) walk(path.join(root, area))
for (const extension of fs.readdirSync(path.join(root, 'wework/dsh'), { withFileTypes: true })) {
  if (!extension.isDirectory()) continue
  const source = path.join(root, 'wework/dsh', extension.name, 'src')
  const client = path.join(root, 'wework/dsh', extension.name, 'client.js')
  if (fs.existsSync(source)) walk(source)
  if (fs.existsSync(client)) inspect(client)
}
if (process.argv.includes('--json')) console.log(JSON.stringify({ files, findings }, null, 2))
else {
  console.log(
    `Inspected ${files} production source files; ${findings.length} controls still need review.`
  )
  for (const issue of findings) console.log(`${issue.file}:${issue.line} ${issue.kind}`)
}
process.exitCode = findings.length ? 1 : 0
