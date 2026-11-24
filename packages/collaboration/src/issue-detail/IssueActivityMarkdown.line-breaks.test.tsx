// @vitest-environment jsdom
import { act } from 'react'
import type { Processor } from 'unified'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AssistantMarkdown, MarkdownServicesProvider, browserMarkdownServices } from '../markdown'
import { IssueActivityMarkdown } from './IssueActivityMarkdown'

const parses = vi.hoisted(() => [] as string[])
vi.mock('../markdown/remarkMathDelimiters', async importOriginal => {
  const actual = await importOriginal<typeof import('../markdown/remarkMathDelimiters')>()
  return {
    ...actual,
    remarkMathDelimiters: function (this: Processor) {
      actual.remarkMathDelimiters.call(this)
      return (_tree: unknown, file: { value: unknown }) => {
        parses.push(String(file.value))
      }
    },
  }
})

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  parses.length = 0
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.documentElement.removeAttribute('data-theme')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each([false, true])('preserves comment line breaks while streaming=%s', async isStreaming => {
  await act(async () =>
    root.render(
      <IssueActivityMarkdown
        isStreaming={isStreaming}
        content={
          'PR: [Wegent#3957](https://github.com/wecode-ai/Wegent/pull/3957)\n结论：审查通过。\n检查：**无数据库迁移**。'
        }
      />
    )
  )
  const paragraph = container.querySelector('p')!
  expect(paragraph.querySelectorAll('br')).toHaveLength(2)
  expect(paragraph.querySelector('strong')?.textContent).toBe('无数据库迁移')
})

it.each([
  ['- First\n  continued\n- Second', 'li', 1],
  ['> First\n> Second', 'blockquote p', 1],
  ['**First\nSecond**', 'strong', 1],
  ['First\r\nSecond', 'p', 1],
  ['First  \nSecond', 'p', 1],
  ['First\n\nSecond', 'p', 0],
  ['Literal \\n stays literal', 'p', 0],
  ['`code stays inline`', 'p', 0],
] as const)('preserves Markdown structure for %s', async (content, selector, breaks) => {
  await act(async () => root.render(<IssueActivityMarkdown content={content} />))
  const element = container.querySelector(selector)!
  expect(element).not.toBeNull()
  expect(element.querySelectorAll('br')).toHaveLength(breaks)
  if (content.includes('\n\n')) expect(container.querySelectorAll('p')).toHaveLength(2)
})

it('preserves code lines without adding HTML breaks inside code blocks', async () => {
  await act(async () =>
    root.render(<IssueActivityMarkdown content={'```ts\nconst first = 1\nconst second = 2\n```'} />)
  )
  const block = container.querySelector('[data-testid="markdown-code-block"]')!
  expect(block.textContent).toContain('const first = 1\nconst second = 2')
  expect(block.querySelectorAll('br')).toHaveLength(0)
})

it('preserves line breaks when activity Markdown uses windowed chunks', async () => {
  await act(async () =>
    root.render(
      <MarkdownServicesProvider value={{ ...browserMarkdownServices, windowMarkdown: true }}>
        <IssueActivityMarkdown content={'First\nSecond'} />
      </MarkdownServicesProvider>
    )
  )
  expect(container.querySelectorAll('p br')).toHaveLength(1)
})

it('preserves line breaks in static document Markdown when requested', async () => {
  await act(async () =>
    root.render(
      <AssistantMarkdown content={'First\nSecond'} variant="document" preserveLineBreaks />
    )
  )
  expect(container.querySelectorAll('p br')).toHaveLength(1)
})

it('keeps ordinary assistant Markdown unchanged and updates line-break preferences', async () => {
  const content = 'First\nSecond'
  await act(async () => root.render(<AssistantMarkdown content={content} />))
  expect(container.querySelectorAll('br')).toHaveLength(0)
  await act(async () => root.render(<AssistantMarkdown content={content} preserveLineBreaks />))
  expect(container.querySelectorAll('br')).toHaveLength(1)
  await act(async () => root.render(<AssistantMarkdown content={content} />))
  expect(container.querySelectorAll('br')).toHaveLength(0)
})

it('anchors document Markdown blocks to source lines only when requested', async () => {
  const content = '# Heading\n\nParagraph\n\n- item\n\nClosing paragraph.'
  await act(async () => root.render(<AssistantMarkdown content={content} variant="document" />))
  expect(container.querySelectorAll('[data-source-line]')).toHaveLength(0)

  await act(async () =>
    root.render(<AssistantMarkdown content={content} variant="document" sourceLineAnchors />)
  )
  expect(container.querySelector('[data-source-line="1"]')?.textContent).toBe('Heading')
  expect(container.querySelector('[data-source-line="3"]')?.textContent).toBe('Paragraph')
  expect(container.querySelector('[data-source-line="5"]')?.textContent).toContain('item')
  expect(container.querySelector('[data-source-line="7"]')?.textContent).toBe(
    'Closing paragraph.'
  )
})

it.each([
  ['default', false],
  ['default', true],
  ['process', false],
] as const)(
  'keeps live %s Markdown mounted through completion with desktop windowing=%s',
  async (variant, windowMarkdown) => {
    const content = '# Heading\n\nParagraph **bold**.\n\n- First\n- Second'
    const services = { ...browserMarkdownServices, windowMarkdown }
    const render = (value: string, isStreaming = false) =>
      act(async () =>
        root.render(
          <MarkdownServicesProvider value={services}>
            <AssistantMarkdown content={value} variant={variant} isStreaming={isStreaming} />
          </MarkdownServicesProvider>
        )
      )
    await render(content, true)
    const parsed = parses.length
    expect(parsed).toBeGreaterThan(0)
    const paragraph = container.querySelector('p')
    await render(content)
    expect(parses).toHaveLength(parsed)
    expect(container.querySelector('p')).toBe(paragraph)
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    await render(content + '\n\nActual new content.')
    expect(parses.length).toBeGreaterThan(parsed)
    expect(container.textContent).toContain('Actual new content.')
  }
)

it('renders tables and following paragraphs in completed desktop Markdown', async () => {
  await act(async () =>
    root.render(
      <MarkdownServicesProvider value={{ ...browserMarkdownServices, windowMarkdown: true }}>
        <AssistantMarkdown
          content={'# Table\n\n| Result |\n| --- |\n| Success |\n\nClosing **note**.'}
        />
      </MarkdownServicesProvider>
    )
  )
  expect(container.querySelector('td')?.textContent).toBe('Success')
  expect(container.querySelector('p strong')?.textContent).toBe('note')
})

it('finalizes an unfinished citation when streaming ends', async () => {
  const content = 'Visible text :codex-followup{prompt='
  await act(async () => root.render(<AssistantMarkdown content={content} isStreaming />))
  expect(container.textContent).not.toContain('codex-followup')
  await act(async () => root.render(<AssistantMarkdown content={content} />))
  expect(container.textContent).toContain('codex-followup')
})

it('finalizes incomplete process Markdown without keeping synthetic delimiters', async () => {
  const content = 'Prefix **unfinished'
  await act(async () =>
    root.render(<AssistantMarkdown content={content} variant="process" isStreaming />)
  )
  expect(container.querySelector('strong')?.textContent).toBe('unfinished')
  await act(async () => root.render(<AssistantMarkdown content={content} variant="process" />))
  expect(container.querySelector('strong')).toBeNull()
  expect(container.textContent).toContain('**unfinished')
})

it.each([
  ':codex-file-citation{path="report.md"}',
  ':codex-followup[Continue]{prompt="Next"}',
])('does not reparse completed annotations at completion: %s', async content => {
  await act(async () => root.render(<AssistantMarkdown content={content} isStreaming />))
  const parsed = parses.length
  expect(parsed).toBeGreaterThan(0)
  const rendered = container.innerHTML
  await act(async () => root.render(<AssistantMarkdown content={content} />))
  expect(parses).toHaveLength(parsed)
  expect(container.innerHTML).toBe(rendered)
})
