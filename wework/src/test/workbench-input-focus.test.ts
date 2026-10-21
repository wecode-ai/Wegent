import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postcss, { type Root } from 'postcss'
import tailwindcss from 'tailwindcss'
import loadConfig from 'tailwindcss/loadConfig'
import { afterEach, beforeAll, expect, test } from 'vitest'

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
const searchSource = readSource('src/components/layout/WorkbenchSearchDialog.tsx')
const browserSource = readSource('src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx')
const tableSource = readSource('src/features/todo/CloudProjectManageView.tsx')
let styles: Root

function inputFromSource(source: string, testId: string) {
  const classes = source
    .slice(source.indexOf(`data-testid="${testId}"`))
    .match(/className="([^"]+)"/)
  expect(classes, testId).not.toBeNull()
  const input = document.createElement('input')
  input.className = classes![1]
  document.body.append(input)
  return input
}

function focusedDeclarations(element: Element, property: string) {
  const declarations: string[] = []
  styles.walkRules(rule => {
    if (!rule.selector.includes(':focus')) return
    if (!rule.selectors.some(selector => element.matches(selector))) return
    rule.walkDecls(property, declaration => {
      declarations.push(declaration.value)
    })
  })
  return declarations
}

beforeAll(async () => {
  const config = loadConfig(resolve(process.cwd(), 'tailwind.config.js'))
  const result = await postcss([
    tailwindcss({
      ...config,
      content: [searchSource, browserSource, tableSource].map(raw => ({
        raw,
        extension: 'tsx',
      })),
    }),
  ]).process(readSource('src/styles/globals.css'), { from: undefined })
  styles = result.root
})

afterEach(() => {
  document.body.replaceChildren()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.classList.remove('dark')
})

test.each(['light', 'dark'])(
  '%s theme limits the host outline override to chrome inputs',
  theme => {
    document.documentElement.dataset.theme = theme
    document.documentElement.classList.toggle('dark', theme === 'dark')
    const search = inputFromSource(searchSource, 'workbench-search-input')
    const address = inputFromSource(browserSource, 'workspace-browser-url-input')
    const table = inputFromSource(tableSource, 'aitable-manage-url')

    // DSH appends a lower-specificity :focus-visible outline-color rule at runtime.
    for (const input of [search, address]) {
      input.focus()
      expect(input.matches(':focus-visible')).toBe(true)
      expect(focusedDeclarations(input, 'outline-color')).toEqual(['transparent'])
      const override = styles.nodes
        .flatMap(node => (node.type === 'rule' ? [node] : []))
        .find(rule => rule.selector === '.workbench-chrome-input:focus-visible')
      expect(override).toBeDefined()
    }

    table.focus()
    expect(table.matches(':focus-visible')).toBe(true)
    expect(focusedDeclarations(table, 'outline-color')).not.toContain('transparent')
  }
)

test('chrome inputs retain focus feedback without adding a border', () => {
  const search = inputFromSource(searchSource, 'workbench-search-input')
  const header = document.createElement('div')
  header.className = searchSource.match(/className="([^"]*group\/search[^"]*)"/)![1]
  const icon = document.createElement('span')
  icon.className = searchSource.match(/<Search className="([^"]+)"/)![1]
  document.body.append(header)
  header.append(icon, search)

  // Match ancestor focus state only after focusing; jsdom caches prior matches.
  search.focus()
  expect(focusedDeclarations(icon, 'color').join()).toContain('--color-text-primary')

  const address = inputFromSource(browserSource, 'workspace-browser-url-input')
  expect(focusedDeclarations(address, 'background-color')).toEqual([])
  address.focus()
  expect(focusedDeclarations(address, 'background-color').join()).toContain('--color-bg-base')
  expect(focusedDeclarations(address, 'border-color')).toEqual([])
  expect(address).toHaveClass('border-0')
})
