// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AssistantMarkdown, MarkdownServicesProvider, browserMarkdownServices } from '../markdown'
import { IssueActivityMarkdown } from './IssueActivityMarkdown'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
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
