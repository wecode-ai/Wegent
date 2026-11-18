import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AssistantMarkdown } from './AssistantMarkdown'

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))

const citation = ':codex-file-citation{path="/tmp/report.xlsx"}'

test('hides incomplete streaming attributes and reveals the complete file reference', () => {
  const { rerender } = render(
    <AssistantMarkdown content={'原稿：:codex-file-citation{path="/tmp/private'} isStreaming />
  )
  expect(document.body).not.toHaveTextContent('private')
  expect(screen.queryByTestId('assistant-markdown-link')).not.toBeInTheDocument()
  rerender(<AssistantMarkdown content={`原稿：${citation}`} />)
  expect(screen.getByTestId('assistant-markdown-link')).toHaveTextContent('report.xlsx')
})

test.each(['javascript:alert(1)', 'data:text/html,hello', 'https://example.com/report.xlsx'])(
  'does not interpret %s as a local file',
  path => {
    render(<AssistantMarkdown content={`:codex-file-citation{path="${path}"}`} />)
    expect(document.querySelector('[data-citation-purpose]')).toBeNull()
  }
)

test('uses the latest file callback without replacing Markdown nodes or losing text selection', () => {
  const first = vi.fn(),
    latest = vi.fn()
  const content = citation + '\n\nText to keep selected.'
  const { container, rerender } = render(<AssistantMarkdown content={content} onOpenFile={first} />)
  const link = screen.getByTestId('assistant-markdown-link')
  const paragraph = Array.from(container.querySelectorAll('p')).find(
    element => element.textContent === 'Text to keep selected.'
  )!
  const selection = window.getSelection()!
  const range = document.createRange()
  range.selectNodeContents(paragraph)
  selection.removeAllRanges()
  selection.addRange(range)
  const selectedText = selection.toString()
  expect(selectedText).toBe('Text to keep selected.')
  try {
    rerender(<AssistantMarkdown content={content} onOpenFile={latest} />)
    expect(screen.getByTestId('assistant-markdown-link')).toBe(link)
    expect(container.contains(paragraph)).toBe(true)
    expect(selection.toString()).toBe(selectedText)
    fireEvent.click(link)
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledExactlyOnceWith('/tmp/report.xlsx')
  } finally {
    selection.removeAllRanges()
  }
})

test('updates file availability in place when the callback is added and removed', () => {
  const onOpenFile = vi.fn()
  const { rerender } = render(<AssistantMarkdown content={citation} />)
  const link = screen.getByTestId('assistant-markdown-link')
  expect(link).toBeDisabled()
  rerender(<AssistantMarkdown content={citation} onOpenFile={onOpenFile} />)
  expect(screen.getByTestId('assistant-markdown-link')).toBe(link)
  expect(link).toBeEnabled()
  fireEvent.click(link)
  expect(onOpenFile).toHaveBeenCalledExactlyOnceWith('/tmp/report.xlsx')
  rerender(<AssistantMarkdown content={citation} />)
  expect(screen.getByTestId('assistant-markdown-link')).toBe(link)
  expect(link).toBeDisabled()
  fireEvent.click(link)
  expect(onOpenFile).toHaveBeenCalledOnce()
})
