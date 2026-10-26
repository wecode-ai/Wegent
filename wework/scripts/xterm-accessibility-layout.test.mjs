import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { test } from 'vitest'

const require = createRequire(import.meta.url)
const packageRoot = dirname(require.resolve('@xterm/xterm/package.json'))
const methodNames = new Set([
  '_renderRows',
  '_refreshRowsDimensions',
  '_refreshRowDimensions',
  '_alignRowWidths',
  '_alignRowWidth',
])

function loadLayout(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(join(packageRoot, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  let target
  const visit = node => {
    if (
      (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
      node.members.some(member => member.name?.getText(source) === '_alignRowWidth')
    ) {
      target = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(target, `Missing accessibility layout in ${file}`)
  const methods = target.members
    .filter(member => methodNames.has(member.name?.getText(source)))
    .map(member => member.getText(source))
  const compiled = ts.transpileModule(`(class { ${methods.join('\n')} })`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  return runInNewContext(compiled)
}

function fixture(Layout) {
  let dirty = false
  let layouts = 0
  const rows = [40, 30, 10].map(width => {
    const row = {
      style: {},
      attributes: {},
      setAttribute(name, value) {
        this.attributes[name] = value
        dirty = true
      },
      getBoundingClientRect() {
        if (dirty) layouts += 1
        dirty = false
        return { width }
      },
    }
    for (const [object, key] of [
      [row, 'textContent'],
      [row.style, 'transform'],
      [row.style, 'height'],
    ]) {
      let current = ''
      Object.defineProperty(object, key, {
        get: () => current,
        set(value) {
          current = value
          dirty = true
        },
      })
    }
    return row
  })
  const lines = [
    { text: 'abcd', columns: [0, 1, 2, 3, 4] },
    { text: '你好', columns: [0, 2, 4] },
    { text: '', columns: [] },
  ]
  const layout = new Layout()
  Object.assign(layout, {
    _rowElements: rows,
    _rowColumns: new Map(rows.map(row => [row, [0, 4]])),
    _announceCharacters() {},
    _accessibilityContainer: { style: {} },
    _terminal: {
      rows: rows.length,
      options: { fontSize: 14 },
      buffer: {
        ydisp: 0,
        lines: {
          length: lines.length,
          get(index) {
            return {
              translateToString(_trim, _start, _end, columns) {
                columns.push(...lines[index].columns)
                return lines[index].text
              },
            }
          },
        },
      },
    },
    _renderService: {
      dimensions: { css: { cell: { width: 10, height: 20 }, canvas: { width: 800 } } },
    },
  })
  return { layout, rows, layouts: () => layouts }
}

for (const file of ['src/browser/AccessibilityManager.ts', 'lib/xterm.js', 'lib/xterm.mjs']) {
  const Layout = loadLayout(file)
  test(`${file}: refreshing rows batches layout while preserving text and character alignment`, () => {
    const { layout, rows, layouts } = fixture(Layout)
    layout._renderRows(0, 2)
    assert.equal(layouts(), 1, 'Row writes must finish before measuring any row')
    assert.deepEqual(
      rows.map(row => row.textContent),
      ['abcd', '你好', '\u00a0']
    )
    assert.deepEqual(
      rows.map(row => row.attributes['aria-posinset']),
      ['1', '2', '3']
    )
    assert.ok(rows.every(row => row.attributes['aria-setsize'] === '3'))
    assert.deepEqual(
      rows.map(row => row.style.transform),
      ['scaleX(1)', `scaleX(${40 / 30})`, 'scaleX(1)']
    )
  })
  test(`${file}: resizing rows batches layout and retains fixed row dimensions`, () => {
    const { layout, rows, layouts } = fixture(Layout)
    layout._refreshRowsDimensions()
    assert.equal(layouts(), 1, 'Dimension writes must finish before measuring any row')
    assert.ok(rows.every(row => row.style.height === '20px'))
    assert.equal(layout._accessibilityContainer.style.width, '800px')
    assert.equal(layout._accessibilityContainer.style.fontSize, '14px')
    assert.deepEqual(
      rows.map(row => row.style.transform),
      ['scaleX(1)', `scaleX(${40 / 30})`, 'scaleX(4)']
    )
  })
}
